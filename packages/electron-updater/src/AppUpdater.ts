import {
  AllPublishOptions,
  asArray,
  CancellationToken,
  newError,
  PublishConfiguration,
  UpdateInfo,
  UUID,
  DownloadOptions,
  CancellationError,
  ProgressInfo,
  BlockMap,
  retry,
} from "builder-util-runtime"
import { randomBytes } from "crypto"
import { release } from "os"
import { EventEmitter } from "events"
import { mkdir, outputFile, readFile, rename, unlink, copyFile, pathExists } from "fs-extra"
import { OutgoingHttpHeaders } from "http"
import { load } from "js-yaml"
import { Lazy } from "lazy-val"
import * as path from "path"
import { eq as isVersionsEqual, gt as isVersionGreaterThan, lt as isVersionLessThan, parse as parseVersion, prerelease as getVersionPreleaseComponents, SemVer } from "semver"
import { AppAdapter } from "./AppAdapter"
import { createTempUpdateFile, DownloadedUpdateHelper } from "./DownloadedUpdateHelper"
import { ElectronAppAdapter } from "./ElectronAppAdapter"
import { ElectronHttpExecutor, getNetSession, LoginCallback } from "./electronHttpExecutor"
import { GenericProvider } from "./providers/GenericProvider"
import { createClient, isUrlProbablySupportMultiRangeRequests } from "./providerFactory"
import { Provider, ProviderPlatform } from "./providers/Provider"
import type { TypedEmitter } from "tiny-typed-emitter"
import Session = Electron.Session
import type { AuthInfo } from "electron"
import { gunzipSync, gzipSync } from "zlib"
import { blockmapFiles } from "./util"
import { DifferentialDownloaderOptions } from "./differentialDownloader/DifferentialDownloader"
import { GenericDifferentialDownloader } from "./differentialDownloader/GenericDifferentialDownloader"
import { DOWNLOAD_PROGRESS, Logger, ResolvedUpdateFileInfo, UPDATE_DOWNLOADED, UpdateCheckResult, UpdateDownloadedEvent, UpdaterSignal } from "./types"
import { VerifyUpdateSupport } from "./main"

export type AppUpdaterEvents = {
  error: (error: Error, message?: string) => void
  login: (info: AuthInfo, callback: LoginCallback) => void
  "checking-for-update": () => void
  "update-not-available": (info: UpdateInfo) => void
  "update-available": (info: UpdateInfo) => void
  "update-downloaded": (event: UpdateDownloadedEvent) => void
  "download-progress": (info: ProgressInfo) => void
  "update-cancelled": (info: UpdateInfo) => void
  "appimage-filename-updated": (path: string) => void
}

export abstract class AppUpdater extends (EventEmitter as new () => TypedEmitter<AppUpdaterEvents>) {
  /**
   * Whether to automatically download an update when it is found.
   * @default true
   */
  autoDownload = true

  /**
   * Whether to automatically install a downloaded update on app quit (if `quitAndInstall` was not called before).
   * @default true
   */
  autoInstallOnAppQuit = true

  /**
   * Whether to run the app after finish install when run the installer is NOT in silent mode.
   * @default true
   */
  autoRunAppAfterInstall = true

  /**
   * *GitHub provider only.* Whether to allow update to pre-release versions. Defaults to `true` if application version contains prerelease components (e.g. `0.12.1-alpha.1`, here `alpha` is a prerelease component), otherwise `false`.
   *
   * If `true`, downgrade will be allowed (`allowDowngrade` will be set to `true`).
   */
  allowPrerelease = false

  /**
   * *GitHub provider only.* Get all release notes (from current version to latest), not just the latest.
   * @default false
   */
  fullChangelog = false

  /**
   * Whether to allow version downgrade (when a user from the beta channel wants to go back to the stable channel).
   *
   * Taken in account only if channel differs (pre-release version component in terms of semantic versioning).
   *
   * @default false
   */
  allowDowngrade = false

  /**
   * Web installer files might not have signature verification, this switch prevents to load them unless it is needed.
   *
   * Currently false to prevent breaking the current API, but it should be changed to default true at some point that
   * breaking changes are allowed.
   *
   * @default false
   */
  disableWebInstaller = false

  /**
   * *NSIS only* Disable differential downloads and always perform full download of installer.
   *
   * @default false
   */
  disableDifferentialDownload = false

  /**
   * Allows developer to force the updater to work in "dev" mode, looking for "dev-app-update.yml" instead of "app-update.yml"
   * Dev: `path.join(this.app.getAppPath(), "dev-app-update.yml")`
   * Prod: `path.join(process.resourcesPath!, "app-update.yml")`
   *
   * @default false
   */
  forceDevUpdateConfig = false

  /**
   * The base URL of the old block map file.
   *
   * When null, the updater will use the base URL of the update file to download the update.
   * When set, the updater will use this string as the base URL of the old block map file.
   * Some servers like github cannot download the old block map file from latest release,
   * so you need to compute the old block map file base URL manually.
   *
   * @default null
   */
  public previousBlockmapBaseUrlOverride: string | null = null

  /**
   * The current application version.
   */
  readonly currentVersion: SemVer

  private _channel: string | null = null

  protected downloadedUpdateHelper: DownloadedUpdateHelper | null = null

  /**
   * Get the update channel. Doesn't return `channel` from the update configuration, only if was previously set.
   */
  get channel(): string | null {
    return this._channel
  }

  /**
   * Set the update channel. Overrides `channel` in the update configuration.
   *
   * `allowDowngrade` will be automatically set to `true`. If this behavior is not suitable for you, simple set `allowDowngrade` explicitly after.
   */
  set channel(value: string | null) {
    if (this._channel != null) {
      // noinspection SuspiciousTypeOfGuard
      if (typeof value !== "string") {
        throw newError(`Channel must be a string, but got: ${value}`, "ERR_UPDATER_INVALID_CHANNEL")
      } else if (value.length === 0) {
        throw newError(`Channel must be not an empty string`, "ERR_UPDATER_INVALID_CHANNEL")
      }
    }

    this._channel = value
    this.allowDowngrade = true
  }

  /**
   *  The request headers.
   */
  requestHeaders: OutgoingHttpHeaders | null = null

  /**
   *  Shortcut for explicitly adding auth tokens to request headers
   */
  addAuthHeader(token: string) {
    this.requestHeaders = Object.assign({}, this.requestHeaders, {
      authorization: token,
    })
  }

  protected _logger: Logger = console

  // noinspection JSMethodCanBeStatic,JSUnusedGlobalSymbols
  get netSession(): Session {
    return getNetSession()
  }

  /**
   * The logger. You can pass [electron-log](https://github.com/megahertz/electron-log), [winston](https://github.com/winstonjs/winston) or another logger with the following interface: `{ info(), warn(), error() }`.
   * Set it to `null` if you would like to disable a logging feature.
   */
  get logger(): Logger | null {
    return this._logger
  }

  set logger(value: Logger | null) {
    this._logger = value == null ? new NoOpLogger() : value
  }

  // noinspection JSUnusedGlobalSymbols
  /**
   * For type safety you can use signals, e.g. `autoUpdater.signals.updateDownloaded(() => {})` instead of `autoUpdater.on('update-available', () => {})`
   */
  readonly signals = new UpdaterSignal(this)

  private _appUpdateConfigPath: string | null = null

  // noinspection JSUnusedGlobalSymbols
  /**
   * test only
   * @private
   */
  set updateConfigPath(value: string | null) {
    this.clientPromise = null
    this._appUpdateConfigPath = value
    this.configOnDisk = new Lazy<any>(() => this.loadUpdateConfig())
  }

  protected _isUpdateSupported: VerifyUpdateSupport = updateInfo => this.checkIfUpdateSupported(updateInfo)

  /**
   * Allows developer to override default logic for determining if an update is supported.
   * The default logic compares the `UpdateInfo` minimum system version against the `os.release()` with `semver` package
   */
  get isUpdateSupported(): VerifyUpdateSupport {
    return this._isUpdateSupported
  }

  set isUpdateSupported(value: VerifyUpdateSupport) {
    if (value) {
      this._isUpdateSupported = value
    }
  }

  protected _isUserWithinRollout: VerifyUpdateSupport = updateInfo => this.isStagingMatch(updateInfo)

  /**
   * Allows developer to override default logic for determining if the user is below the rollout threshold.
   * The default logic compares the staging percentage with numerical representation of user ID.
   * An override can define custom logic, or bypass it if needed.
   */
  get isUserWithinRollout(): VerifyUpdateSupport {
    return this._isUserWithinRollout
  }

  set isUserWithinRollout(value: VerifyUpdateSupport) {
    if (value) {
      this._isUserWithinRollout = value
    }
  }

  private clientPromise: Promise<Provider<any>> | null = null

  protected readonly stagingUserIdPromise = new Lazy<string>(() => this.getOrCreateStagingUserId())

  // public, allow to read old config for anyone
  /** @internal */
  configOnDisk = new Lazy<any>(() => this.loadUpdateConfig())

  private checkForUpdatesPromise: Promise<UpdateCheckResult> | null = null
  private downloadPromise: Promise<Array<string>> | null = null

  protected readonly app: AppAdapter

  protected updateInfoAndProvider: UpdateInfoAndProvider | null = null

  /** @internal */
  readonly httpExecutor: ElectronHttpExecutor

  protected constructor(options: AllPublishOptions | null | undefined, app?: AppAdapter) {
    super()

    this.on("error", (error: Error) => {
      this._logger.error(`Error: ${error.stack || error.message}`)
    })

    if (app == null) {
      this.app = new ElectronAppAdapter()
      this.httpExecutor = new ElectronHttpExecutor((authInfo, callback) => this.emit("login", authInfo, callback))
    } else {
      this.app = app
      this.httpExecutor = null as any
    }

    const currentVersionString = this.app.version
    const currentVersion = parseVersion(currentVersionString)
    if (currentVersion == null) {
      throw newError(`App version is not a valid semver version: "${currentVersionString}"`, "ERR_UPDATER_INVALID_VERSION")
    }
    this.currentVersion = currentVersion
    this.allowPrerelease = hasPrereleaseComponents(currentVersion)

    if (options != null) {
      this.setFeedURL(options)

      if (typeof options !== "string" && options.requestHeaders) {
        this.requestHeaders = options.requestHeaders
      }
    }
  }

  //noinspection JSMethodCanBeStatic,JSUnusedGlobalSymbols
  getFeedURL(): string | null | undefined {
    return "Deprecated. Do not use it."
  }

  /**
   * Configure update provider. If value is `string`, [GenericServerOptions](./publish.md#genericserveroptions) will be set with value as `url`.
   * @param options If you want to override configuration in the `app-update.yml`.
   */
  setFeedURL(options: PublishConfiguration | AllPublishOptions | string) {
    const runtimeOptions = this.createProviderRuntimeOptions()
    // https://github.com/electron-userland/electron-builder/issues/1105
    let provider: Provider<any>
    if (typeof options === "string") {
      provider = new GenericProvider({ provider: "generic", url: options }, this, {
        ...runtimeOptions,
        isUseMultipleRangeRequest: isUrlProbablySupportMultiRangeRequests(options),
      })
    } else {
      provider = createClient(options, this, runtimeOptions)
    }
    this.clientPromise = Promise.resolve(provider)
  }

  /**
   * Asks the server whether there is an update.
   * @returns null if the updater is disabled, otherwise info about the latest version
   */
  checkForUpdates(): Promise<UpdateCheckResult | null> {
    if (!this.isUpdaterActive()) {
      return Promise.resolve(null)
    }

    let checkForUpdatesPromise = this.checkForUpdatesPromise
    if (checkForUpdatesPromise != null) {
      this._logger.info("Checking for update (already in progress)")
      return checkForUpdatesPromise
    }

    const nullizePromise = () => (this.checkForUpdatesPromise = null)

    this._logger.info("Checking for update")
    checkForUpdatesPromise = this.doCheckForUpdates()
      .then(it => {
        nullizePromise()
        return it
      })
      .catch((e: any) => {
        nullizePromise()
        this.emit("error", e, `Cannot check for updates: ${(e.stack || e).toString()}`)
        throw e
      })

    this.checkForUpdatesPromise = checkForUpdatesPromise
    return checkForUpdatesPromise
  }

  public isUpdaterActive(): boolean {
    const isEnabled = this.app.isPackaged || this.forceDevUpdateConfig
    if (!isEnabled) {
      this._logger.info("Skip checkForUpdates because application is not packed and dev update config is not forced")
      return false
    }
    return true
  }

  // noinspection JSUnusedGlobalSymbols
  checkForUpdatesAndNotify(downloadNotification?: DownloadNotification): Promise<UpdateCheckResult | null> {
    return this.checkForUpdates().then(it => {
      if (!it?.downloadPromise) {
        if (this._logger.debug != null) {
          this._logger.debug("checkForUpdatesAndNotify called, downloadPromise is null")
        }
        return it
      }

      void it.downloadPromise.then(() => {
        const notificationContent = AppUpdater.formatDownloadNotification(it.updateInfo.version, this.app.name, downloadNotification)
        new (require("electron").Notification)(notificationContent).show()
      })

      return it
    })
  }

  private static formatDownloadNotification(version: string, appName: string, downloadNotification?: DownloadNotification): DownloadNotification {
    if (downloadNotification == null) {
      downloadNotification = {
        title: "A new update is ready to install",
        body: `{appName} version {version} has been downloaded and will be automatically installed on exit`,
      }
    }
    downloadNotification = {
      title: downloadNotification.title.replace("{appName}", appName).replace("{version}", version),
      body: downloadNotification.body.replace("{appName}", appName).replace("{version}", version),
    }
    return downloadNotification
  }

  private async isStagingMatch(updateInfo: UpdateInfo): Promise<boolean> {
    const rawStagingPercentage = updateInfo.stagingPercentage
    let stagingPercentage = rawStagingPercentage
    if (stagingPercentage == null) {
      return true
    }

    stagingPercentage = parseInt(stagingPercentage as any, 10)
    if (isNaN(stagingPercentage)) {
      this._logger.warn(`Staging percentage is NaN: ${rawStagingPercentage}`)
      return true
    }

    // convert from user 0-100 to internal 0-1
    stagingPercentage = stagingPercentage / 100

    const stagingUserId = await this.stagingUserIdPromise.value
    const val = UUID.parse(stagingUserId).readUInt32BE(12)
    const percentage = val / 0xffffffff
    this._logger.info(`Staging percentage: ${stagingPercentage}, percentage: ${percentage}, user id: ${stagingUserId}`)
    return percentage < stagingPercentage
  }

  private computeFinalHeaders(headers: OutgoingHttpHeaders) {
    if (this.requestHeaders != null) {
      Object.assign(headers, this.requestHeaders)
    }
    return headers
  }

  private async isUpdateAvailable(updateInfo: UpdateInfo): Promise<boolean> {
    const latestVersion = parseVersion(updateInfo.version)
    if (latestVersion == null) {
      throw newError(
        `This file could not be downloaded, or the latest version (from update server) does not have a valid semver version: "${updateInfo.version}"`,
        "ERR_UPDATER_INVALID_VERSION"
      )
    }

    const currentVersion = this.currentVersion
    if (isVersionsEqual(latestVersion, currentVersion)) {
      return false
    }

    if (!(await Promise.resolve(this.isUpdateSupported(updateInfo)))) {
      return false
    }

    const isUserWithinRollout = await Promise.resolve(this.isUserWithinRollout(updateInfo))
    if (!isUserWithinRollout) {
      return false
    }

    // https://github.com/electron-userland/electron-builder/pull/3111#issuecomment-405033227
    // https://github.com/electron-userland/electron-builder/pull/3111#issuecomment-405030797
    const isLatestVersionNewer = isVersionGreaterThan(latestVersion, currentVersion)
    const isLatestVersionOlder = isVersionLessThan(latestVersion, currentVersion)

    if (isLatestVersionNewer) {
      return true
    }
    return this.allowDowngrade && isLatestVersionOlder
  }

  private checkIfUpdateSupported(updateInfo: UpdateInfo) {
    const minimumSystemVersion = updateInfo?.minimumSystemVersion
    const currentOSVersion = release()
    if (minimumSystemVersion) {
      try {
        if (isVersionLessThan(currentOSVersion, minimumSystemVersion)) {
          this._logger.info(`Current OS version ${currentOSVersion} is less than the minimum OS version required ${minimumSystemVersion} for version ${currentOSVersion}`)
          return false
        }
      } catch (e: any) {
        this._logger.warn(`Failed to compare current OS version(${currentOSVersion}) with minimum OS version(${minimumSystemVersion}): ${(e.message || e).toString()}`)
      }
    }
    return true
  }

  protected async getUpdateInfoAndProvider(): Promise<UpdateInfoAndProvider> {
    await this.app.whenReady()

    if (this.clientPromise == null) {
      this.clientPromise = this.configOnDisk.value.then(it => createClient(it, this, this.createProviderRuntimeOptions()))
    }

    const client = await this.clientPromise
    const stagingUserId = await this.stagingUserIdPromise.value
    client.setRequestHeaders(this.computeFinalHeaders({ "x-user-staging-id": stagingUserId }))
    return {
      info: await client.getLatestVersion(),
      provider: client,
    }
  }

  private createProviderRuntimeOptions() {
    return {
      isUseMultipleRangeRequest: true,
      platform: this._testOnlyOptions == null ? (process.platform as ProviderPlatform) : this._testOnlyOptions.platform,
      executor: this.httpExecutor,
    }
  }

  private async doCheckForUpdates(): Promise<UpdateCheckResult> {
    this.emit("checking-for-update")

    const result = await this.getUpdateInfoAndProvider()
    const updateInfo = result.info
    if (!(await this.isUpdateAvailable(updateInfo))) {
      this._logger.info(
        `Update for version ${this.currentVersion.format()} is not available (latest version: ${updateInfo.version}, downgrade is ${
          this.allowDowngrade ? "allowed" : "disallowed"
        }).`
      )
      this.emit("update-not-available", updateInfo)
      return {
        isUpdateAvailable: false,
        versionInfo: updateInfo,
        updateInfo,
      }
    }

    this.updateInfoAndProvider = result
    this.onUpdateAvailable(updateInfo)

    const cancellationToken = new CancellationToken()
    //noinspection ES6MissingAwait
    return {
      isUpdateAvailable: true,
      versionInfo: updateInfo,
      updateInfo,
      cancellationToken,
      downloadPromise: this.autoDownload ? this.downloadUpdate(cancellationToken) : null,
    }
  }

  protected onUpdateAvailable(updateInfo: UpdateInfo): void {
    this._logger.info(
      `Found version ${updateInfo.version} (url: ${asArray(updateInfo.files)
        .map(it => it.url)
        .join(", ")})`
    )
    this.emit("update-available", updateInfo)
  }

  /**
   * Start downloading update manually. You can use this method if `autoDownload` option is set to `false`.
   * @returns {Promise<Array<string>>} Paths to downloaded files.
   */
  downloadUpdate(cancellationToken: CancellationToken = new CancellationToken()): Promise<Array<string>> {
    const updateInfoAndProvider = this.updateInfoAndProvider
    if (updateInfoAndProvider == null) {
      const error = new Error("Please check update first")
      this.dispatchError(error)
      return Promise.reject(error)
    }

    if (this.downloadPromise != null) {
      this._logger.info("Downloading update (already in progress)")
      return this.downloadPromise
    }

    this._logger.info(
      `Downloading update from ${asArray(updateInfoAndProvider.info.files)
        .map(it => it.url)
        .join(", ")}`
    )
    const errorHandler = (e: Error): Error => {
      // https://github.com/electron-userland/electron-builder/issues/1150#issuecomment-436891159
      if (!(e instanceof CancellationError)) {
        try {
          this.dispatchError(e)
        } catch (nestedError: any) {
          this._logger.warn(`Cannot dispatch error event: ${nestedError.stack || nestedError}`)
        }
      }

      return e
    }

    this.downloadPromise = this.doDownloadUpdate({
      updateInfoAndProvider,
      requestHeaders: this.computeRequestHeaders(updateInfoAndProvider.provider),
      cancellationToken,
      disableWebInstaller: this.disableWebInstaller,
      disableDifferentialDownload: this.disableDifferentialDownload,
    })
      .catch((e: any) => {
        throw errorHandler(e)
      })
      .finally(() => {
        this.downloadPromise = null
      })

    return this.downloadPromise
  }

  protected dispatchError(e: Error): void {
    this.emit("error", e, (e.stack || e).toString())
  }

  protected dispatchUpdateDownloaded(event: UpdateDownloadedEvent): void {
    this.emit(UPDATE_DOWNLOADED, event)
  }

  protected abstract doDownloadUpdate(downloadUpdateOptions: DownloadUpdateOptions): Promise<Array<string>>

  /**
   * Restarts the app and installs the update after it has been downloaded.
   * It should only be called after `update-downloaded` has been emitted.
   *
   * **Note:** `autoUpdater.quitAndInstall()` will close all application windows first and only emit `before-quit` event on `app` after that.
   * This is different from the normal quit event sequence.
   *
   * @param isSilent *windows-only* Runs the installer in silent mode. Defaults to `false`.
   * @param isForceRunAfter Run the app after finish even on silent install. Not applicable for macOS.
   * Ignored if `isSilent` is set to `false`(In this case you can still set `autoRunAppAfterInstall` to `false` to prevent run the app after finish).
   */
  abstract quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void

  private async loadUpdateConfig(): Promise<any> {
    if (this._appUpdateConfigPath == null) {
      this._appUpdateConfigPath = this.app.appUpdateConfigPath
    }
    return load(await readFile(this._appUpdateConfigPath, "utf-8"))
  }

  private computeRequestHeaders(provider: Provider<any>): OutgoingHttpHeaders {
    const fileExtraDownloadHeaders = provider.fileExtraDownloadHeaders
    if (fileExtraDownloadHeaders != null) {
      const requestHeaders = this.requestHeaders
      return requestHeaders == null
        ? fileExtraDownloadHeaders
        : {
            ...fileExtraDownloadHeaders,
            ...requestHeaders,
          }
    }
    return this.computeFinalHeaders({ accept: "*/*" })
  }

  private async getOrCreateStagingUserId(): Promise<string> {
    const file = path.join(this.app.userDataPath, ".updaterId")
    try {
      const id = await readFile(file, "utf-8")
      if (UUID.check(id)) {
        return id
      } else {
        this._logger.warn(`Staging user id file exists, but content was invalid: ${id}`)
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        this._logger.warn(`Couldn't read staging user ID, creating a blank one: ${e}`)
      }
    }

    const id = UUID.v5(randomBytes(4096), UUID.OID)
    this._logger.info(`Generated new staging user ID: ${id}`)
    try {
      await outputFile(file, id)
    } catch (e: any) {
      this._logger.warn(`Couldn't write out staging user ID: ${e}`)
    }
    return id
  }

  /** @internal */
  get isAddNoCacheQuery(): boolean {
    const headers = this.requestHeaders
    // https://github.com/electron-userland/electron-builder/issues/3021
    if (headers == null) {
      return true
    }

    for (const headerName of Object.keys(headers)) {
      const s = headerName.toLowerCase()
      if (s === "authorization" || s === "private-token") {
        return false
      }
    }
    return true
  }

  /**
   * @private
   * @internal
   */
  _testOnlyOptions: TestOnlyUpdaterOptions | null = null

  private async getOrCreateDownloadHelper(): Promise<DownloadedUpdateHelper> {
    let result = this.downloadedUpdateHelper
    if (result == null) {
      const dirName = (await this.configOnDisk.value).updaterCacheDirName
      const logger = this._logger
      if (dirName == null) {
        logger.error("updaterCacheDirName is not specified in app-update.yml Was app build using at least electron-builder 20.34.0?")
      }
      const cacheDir = path.join(this.app.baseCachePath, dirName || this.app.name)
      if (logger.debug != null) {
        logger.debug(`updater cache dir: ${cacheDir}`)
      }

      result = new DownloadedUpdateHelper(cacheDir)
      this.downloadedUpdateHelper = result
    }
    return result
  }

  protected async executeDownload(taskOptions: DownloadExecutorTask): Promise<Array<string>> {
    const fileInfo = taskOptions.fileInfo
    const downloadOptions: DownloadOptions = {
      headers: taskOptions.downloadUpdateOptions.requestHeaders,
      cancellationToken: taskOptions.downloadUpdateOptions.cancellationToken,
      sha2: (fileInfo.info as any).sha2,
      sha512: fileInfo.info.sha512,
    }

    if (this.listenerCount(DOWNLOAD_PROGRESS) > 0) {
      downloadOptions.onProgress = it => this.emit(DOWNLOAD_PROGRESS, it)
    }

    const updateInfo = taskOptions.downloadUpdateOptions.updateInfoAndProvider.info
    const version = updateInfo.version
    const packageInfo = fileInfo.packageInfo

    function getCacheUpdateFileName(): string {
      // NodeJS URL doesn't decode automatically
      const urlPath = decodeURIComponent(taskOptions.fileInfo.url.pathname)
      if (urlPath.toLowerCase().endsWith(`.${taskOptions.fileExtension.toLowerCase()}`)) {
        return path.basename(urlPath)
      } else {
        // url like /latest, generate name
        return taskOptions.fileInfo.info.url
      }
    }

    const downloadedUpdateHelper = await this.getOrCreateDownloadHelper()
    const cacheDir = downloadedUpdateHelper.cacheDirForPendingUpdate
    await mkdir(cacheDir, { recursive: true })
    const updateFileName = getCacheUpdateFileName()
    let updateFile = path.join(cacheDir, updateFileName)
    const packageFile = packageInfo == null ? null : path.join(cacheDir, `package-${version}${path.extname(packageInfo.path) || ".7z"}`)

    const done = async (isSaveCache: boolean) => {
      await downloadedUpdateHelper.setDownloadedFile(updateFile, packageFile, updateInfo, fileInfo, updateFileName, isSaveCache)
      await taskOptions.done!({
        ...updateInfo,
        downloadedFile: updateFile,
      })
      const currentBlockMapFile = path.join(cacheDir, "current.blockmap")
      if (await pathExists(currentBlockMapFile)) {
        await copyFile(currentBlockMapFile, path.join(downloadedUpdateHelper.cacheDir, "current.blockmap"))
      }
      return packageFile == null ? [updateFile] : [updateFile, packageFile]
    }

    const log = this._logger
    const cachedUpdateFile = await downloadedUpdateHelper.validateDownloadedPath(updateFile, updateInfo, fileInfo, log)
    if (cachedUpdateFile != null) {
      updateFile = cachedUpdateFile
      return await done(false)
    }

    const removeFileIfAny = async () => {
      await downloadedUpdateHelper.clear().catch(() => {
        // ignore
      })
      return await unlink(updateFile).catch(() => {
        // ignore
      })
    }

    const tempUpdateFile = await createTempUpdateFile(`temp-${updateFileName}`, cacheDir, log)
    try {
      await taskOptions.task(tempUpdateFile, downloadOptions, packageFile, removeFileIfAny)
      await retry(() => rename(tempUpdateFile, updateFile), {
        retries: 60,
        interval: 500,
        shouldRetry: (error: Error) => {
          if (error instanceof Error && /^EBUSY:/.test(error.message)) {
            return true
          }
          log.warn(`Cannot rename temp file to final file: ${error.message || error.stack}`)
          return false
        },
      })
    } catch (e: any) {
      await removeFileIfAny()

      if (e instanceof CancellationError) {
        log.info("cancelled")
        this.emit("update-cancelled", updateInfo)
      }
      throw e
    }

    log.info(`New version ${version} has been downloaded to ${updateFile}`)
    return await done(true)
  }
  protected async differentialDownloadInstaller(
    fileInfo: ResolvedUpdateFileInfo,
    downloadUpdateOptions: DownloadUpdateOptions,
    installerPath: string,
    provider: Provider<any>,
    oldInstallerFileName: string
  ): Promise<boolean> {
    try {
      if (this._testOnlyOptions != null && !this._testOnlyOptions.isUseDifferentialDownload) {
        return true
      }
      const blockmapFileUrls = blockmapFiles(fileInfo.url, this.app.version, downloadUpdateOptions.updateInfoAndProvider.info.version, this.previousBlockmapBaseUrlOverride)
      this._logger.info(`Download block maps (old: "${blockmapFileUrls[0]}", new: ${blockmapFileUrls[1]})`)

      const downloadBlockMap = async (url: URL): Promise<BlockMap> => {
        const data = await this.httpExecutor.downloadToBuffer(url, {
          headers: downloadUpdateOptions.requestHeaders,
          cancellationToken: downloadUpdateOptions.cancellationToken,
        })

        if (data == null || data.length === 0) {
          throw new Error(`Blockmap "${url.href}" is empty`)
        }

        try {
          return JSON.parse(gunzipSync(data).toString())
        } catch (e: any) {
          throw new Error(`Cannot parse blockmap "${url.href}", error: ${e}`)
        }
      }

      const downloadOptions: DifferentialDownloaderOptions = {
        newUrl: fileInfo.url,
        oldFile: path.join(this.downloadedUpdateHelper!.cacheDir, oldInstallerFileName),
        logger: this._logger,
        newFile: installerPath,
        isUseMultipleRangeRequest: provider.isUseMultipleRangeRequest,
        requestHeaders: downloadUpdateOptions.requestHeaders,
        cancellationToken: downloadUpdateOptions.cancellationToken,
      }

      if (this.listenerCount(DOWNLOAD_PROGRESS) > 0) {
        downloadOptions.onProgress = it => this.emit(DOWNLOAD_PROGRESS, it)
      }

      const saveBlockMapToCacheDir = async (blockMapData: BlockMap, cacheDir: string) => {
        const blockMapFile = path.join(cacheDir, "current.blockmap")
        await outputFile(blockMapFile, gzipSync(JSON.stringify(blockMapData)))
      }

      const getBlockMapFromCacheDir = async (cacheDir: string) => {
        const blockMapFile = path.join(cacheDir, "current.blockmap")
        try {
          if (await pathExists(blockMapFile)) {
            return JSON.parse(gunzipSync(await readFile(blockMapFile)).toString())
          }
        } catch (e: any) {
          this._logger.warn(`Cannot parse blockmap "${blockMapFile}", error: ${e}`)
        }
        return null
      }

      const newBlockMapData = await downloadBlockMap(blockmapFileUrls[1])
      await saveBlockMapToCacheDir(newBlockMapData, this.downloadedUpdateHelper!.cacheDirForPendingUpdate)

      // get old blockmap from cache dir first, if not found, download it
      let oldBlockMapData = await getBlockMapFromCacheDir(this.downloadedUpdateHelper!.cacheDir)
      if (oldBlockMapData == null) {
        oldBlockMapData = await downloadBlockMap(blockmapFileUrls[0])
      }

      await new GenericDifferentialDownloader(fileInfo.info, this.httpExecutor, downloadOptions).download(oldBlockMapData, newBlockMapData)
      return false
    } catch (e: any) {
      this._logger.error(`Cannot download differentially, fallback to full download: ${e.stack || e}`)
      if (this._testOnlyOptions != null) {
        // test mode
        throw e
      }
      return true
    }
  }
}

export interface DownloadUpdateOptions {
  readonly updateInfoAndProvider: UpdateInfoAndProvider
  readonly requestHeaders: OutgoingHttpHeaders
  readonly cancellationToken: CancellationToken
  readonly disableWebInstaller?: boolean
  readonly disableDifferentialDownload?: boolean
}

function hasPrereleaseComponents(version: SemVer) {
  const versionPrereleaseComponent = getVersionPreleaseComponents(version)
  return versionPrereleaseComponent != null && versionPrereleaseComponent.length > 0
}

/** @private */
export class NoOpLogger implements Logger {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  info(message?: any) {
    // ignore
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  warn(message?: any) {
    // ignore
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  error(message?: any) {
    // ignore
  }
}

export interface UpdateInfoAndProvider {
  info: UpdateInfo
  provider: Provider<any>
}

export interface DownloadExecutorTask {
  readonly fileExtension: string
  readonly fileInfo: ResolvedUpdateFileInfo
  readonly downloadUpdateOptions: DownloadUpdateOptions
  readonly task: (destinationFile: string, downloadOptions: DownloadOptions, packageFile: string | null, removeTempDirIfAny: () => Promise<any>) => Promise<any>

  readonly done?: (event: UpdateDownloadedEvent) => Promise<any>
}

export interface DownloadNotification {
  body: string
  title: string
}

/** @private */
export interface TestOnlyUpdaterOptions {
  platform: ProviderPlatform

  isUseDifferentialDownload?: boolean
}
