import { flipFuses, FuseConfig, FuseV1Config, FuseV1Options, FuseVersion } from "@electron/fuses"
import {
  Arch,
  asArray,
  AsyncTaskManager,
  DebugLogger,
  deepAssign,
  defaultArchFromString,
  FileTransformer,
  getArchSuffix,
  getArtifactArchName,
  InvalidConfigurationError,
  isEmptyOrSpaces,
  log,
  orIfFileNotExist,
  statOrNull,
} from "builder-util"
import { Nullish } from "builder-util-runtime"
import { readdir } from "fs/promises"
import { Lazy } from "lazy-val"
import { Minimatch } from "minimatch"
import * as path from "path"
import { AppInfo } from "./appInfo"
import { checkFileInArchive } from "./asar/asarFileChecker"
import { AsarPackager } from "./asar/asarUtil"
import { AsarIntegrity, computeData } from "./asar/integrity"
import { FuseOptionsV1 } from "./configuration"
import { copyFiles, FileMatcher, getFileMatchers, GetFileMatchersOptions, getMainFileMatchers, getNodeModuleFileMatcher } from "./fileMatcher"
import { createTransformer, isElectronCompileUsed } from "./fileTransformer"
import { Framework, isElectronBased } from "./Framework"
import {
  AfterPackContext,
  AsarOptions,
  CompressionLevel,
  Configuration,
  ElectronPlatformName,
  FileAssociation,
  LinuxPackager,
  Packager,
  PackagerOptions,
  Platform,
  PlatformSpecificBuildOptions,
  Target,
  TargetSpecificOptions,
} from "./index"
import { executeAppBuilderAsJson } from "./util/appBuilder"
import { computeFileSets, computeNodeModuleFileSets, copyAppFiles, ELECTRON_COMPILE_SHIM_FILENAME, transformFiles } from "./util/appFileCopier"
import { expandMacro as doExpandMacro } from "./util/macroExpander"

export type DoPackOptions<DC extends PlatformSpecificBuildOptions> = {
  outDir: string
  appOutDir: string
  platformName: ElectronPlatformName
  arch: Arch
  platformSpecificBuildOptions: DC
  targets: Array<Target>
  options?: {
    sign?: boolean
    disableAsarIntegrity?: boolean
    disableFuses?: boolean
  }
}

export abstract class PlatformPackager<DC extends PlatformSpecificBuildOptions> {
  get packagerOptions(): PackagerOptions {
    return this.info.options
  }

  get buildResourcesDir(): string {
    return this.info.buildResourcesDir
  }

  get projectDir(): string {
    return this.info.projectDir
  }

  get config(): Configuration {
    return this.info.config
  }

  readonly platformSpecificBuildOptions: DC

  get resourceList(): Promise<Array<string>> {
    return this._resourceList.value
  }

  private readonly _resourceList = new Lazy<Array<string>>(() => orIfFileNotExist(readdir(this.info.buildResourcesDir), []))

  readonly appInfo: AppInfo

  protected constructor(
    readonly info: Packager,
    readonly platform: Platform
  ) {
    this.platformSpecificBuildOptions = PlatformPackager.normalizePlatformSpecificBuildOptions((this.config as any)[platform.buildConfigurationKey])
    this.appInfo = this.prepareAppInfo(info.appInfo)
  }

  get compression(): CompressionLevel {
    const compression = this.platformSpecificBuildOptions.compression
    // explicitly set to null - request to use default value instead of parent (in the config)
    if (compression === null) {
      return "normal"
    }
    return compression || this.config.compression || "normal"
  }

  get debugLogger(): DebugLogger {
    return this.info.debugLogger
  }

  abstract get defaultTarget(): Array<string>

  // eslint-disable-next-line
  protected prepareAppInfo(appInfo: AppInfo) {
    return new AppInfo(this.info, null, this.platformSpecificBuildOptions)
  }

  private static normalizePlatformSpecificBuildOptions(options: any | Nullish): any {
    return options == null ? Object.create(null) : options
  }

  abstract createTargets(targets: Array<string>, mapper: (name: string, factory: (outDir: string) => Target) => void): void

  getCscPassword(): string {
    const password = this.doGetCscPassword()
    if (isEmptyOrSpaces(password)) {
      log.info({ reason: "CSC_KEY_PASSWORD is not defined" }, "empty password will be used for code signing")
      return ""
    } else {
      return password.trim()
    }
  }

  getCscLink(extraEnvName?: string | null): string | Nullish {
    // allow to specify as empty string
    const envValue = chooseNotNull(extraEnvName == null ? null : process.env[extraEnvName], process.env.CSC_LINK)
    return chooseNotNull(chooseNotNull(this.info.config.cscLink, this.platformSpecificBuildOptions.cscLink), envValue)
  }

  doGetCscPassword(): string | Nullish {
    // allow to specify as empty string
    return chooseNotNull(chooseNotNull(this.info.config.cscKeyPassword, this.platformSpecificBuildOptions.cscKeyPassword), process.env.CSC_KEY_PASSWORD)
  }

  protected computeAppOutDir(outDir: string, arch: Arch): string {
    return (
      this.packagerOptions.prepackaged ||
      path.join(
        outDir,
        `${this.platform.buildConfigurationKey}${getArchSuffix(arch, this.platformSpecificBuildOptions.defaultArch)}${this.platform === Platform.MAC ? "" : "-unpacked"}`
      )
    )
  }

  async pack(outDir: string, arch: Arch, targets: Array<Target>, taskManager: AsyncTaskManager): Promise<any> {
    const appOutDir = this.computeAppOutDir(outDir, arch)
    await this.doPack({
      outDir,
      appOutDir,
      platformName: this.platform.nodeName as ElectronPlatformName,
      arch,
      platformSpecificBuildOptions: this.platformSpecificBuildOptions,
      targets,
    })
    this.packageInDistributableFormat(appOutDir, arch, targets, taskManager)
  }

  protected packageInDistributableFormat(appOutDir: string, arch: Arch, targets: Array<Target>, taskManager: AsyncTaskManager): void {
    if (targets.find(it => !it.isAsyncSupported) == null) {
      PlatformPackager.buildAsyncTargets(targets, taskManager, appOutDir, arch)
      return
    }

    taskManager.add(async () => {
      // BluebirdPromise.map doesn't invoke target.build immediately, but for RemoteTarget it is very critical to call build() before finishBuild()
      const subTaskManager = new AsyncTaskManager(this.info.cancellationToken)
      PlatformPackager.buildAsyncTargets(targets, subTaskManager, appOutDir, arch)
      await subTaskManager.awaitTasks()

      for (const target of targets) {
        if (!target.isAsyncSupported && !this.info.cancellationToken.cancelled) {
          await target.build(appOutDir, arch)
        }
      }
    })
  }

  private static buildAsyncTargets(targets: Array<Target>, taskManager: AsyncTaskManager, appOutDir: string, arch: Arch) {
    for (const target of targets) {
      if (target.isAsyncSupported) {
        taskManager.addTask(target.build(appOutDir, arch))
      }
    }
  }

  private getExtraFileMatchers(isResources: boolean, appOutDir: string, options: GetFileMatchersOptions): Array<FileMatcher> | null {
    const base = isResources
      ? this.getResourcesDir(appOutDir)
      : this.platform === Platform.MAC
        ? path.join(appOutDir, `${this.appInfo.productFilename}.app`, "Contents")
        : appOutDir
    return getFileMatchers(this.config, isResources ? "extraResources" : "extraFiles", base, options)
  }

  createGetFileMatchersOptions(outDir: string, arch: Arch, customBuildOptions: PlatformSpecificBuildOptions): GetFileMatchersOptions {
    return {
      macroExpander: it => this.expandMacro(it, arch == null ? null : Arch[arch], { "/*": "{,/**/*}" }),
      customBuildOptions,
      globalOutDir: outDir,
      defaultSrc: this.projectDir,
    }
  }

  protected async doPack(packOptions: DoPackOptions<DC>) {
    if (this.packagerOptions.prepackaged != null) {
      return
    }

    if (this.info.cancellationToken.cancelled) {
      return
    }

    // Due to node-gyp rewriting GYP_MSVS_VERSION when reused across the same session, we must reset the env var: https://github.com/electron-userland/electron-builder/issues/7256
    delete process.env.GYP_MSVS_VERSION

    const { outDir, appOutDir, platformName, arch, platformSpecificBuildOptions, targets, options } = packOptions

    await this.info.emitBeforePack({
      appOutDir,
      outDir,
      arch,
      targets,
      packager: this,
      electronPlatformName: platformName,
    })

    await this.info.installAppDependencies(this.platform, arch)

    if (this.info.cancellationToken.cancelled) {
      return
    }

    const framework = this.info.framework
    log.info(
      {
        platform: platformName,
        arch: Arch[arch],
        [`${framework.name}`]: framework.version,
        appOutDir: log.filePath(appOutDir),
      },
      `packaging`
    )

    await framework.prepareApplicationStageDirectory({
      packager: this,
      appOutDir,
      platformName,
      arch: Arch[arch],
      version: framework.version,
    })

    await this.info.emitAfterExtract({
      appOutDir,
      outDir,
      arch,
      targets,
      packager: this,
      electronPlatformName: platformName,
    })

    const excludePatterns: Array<Minimatch> = []

    const computeParsedPatterns = (patterns: Array<FileMatcher> | null) => {
      if (patterns != null) {
        for (const pattern of patterns) {
          pattern.computeParsedPatterns(excludePatterns, this.info.projectDir)
        }
      }
    }

    const getFileMatchersOptions = this.createGetFileMatchersOptions(outDir, arch, platformSpecificBuildOptions)
    const macroExpander = getFileMatchersOptions.macroExpander
    const extraResourceMatchers = this.getExtraFileMatchers(true, appOutDir, getFileMatchersOptions)
    computeParsedPatterns(extraResourceMatchers)
    const extraFileMatchers = this.getExtraFileMatchers(false, appOutDir, getFileMatchersOptions)
    computeParsedPatterns(extraFileMatchers)

    const packContext: AfterPackContext = {
      appOutDir,
      outDir,
      arch,
      targets,
      packager: this,
      electronPlatformName: platformName,
    }

    const asarOptions = await this.computeAsarOptions(platformSpecificBuildOptions)
    const resourcesPath =
      this.platform === Platform.MAC
        ? path.join(appOutDir, framework.distMacOsAppName, "Contents", "Resources")
        : isElectronBased(framework)
          ? path.join(appOutDir, "resources")
          : appOutDir
    const taskManager = new AsyncTaskManager(this.info.cancellationToken)
    this.copyAppFiles(taskManager, asarOptions, resourcesPath, path.join(resourcesPath, "app"), packContext, platformSpecificBuildOptions, excludePatterns, macroExpander)
    await taskManager.awaitTasks()

    if (this.info.cancellationToken.cancelled) {
      return
    }

    if (framework.beforeCopyExtraFiles != null) {
      const resourcesRelativePath = this.platform === Platform.MAC ? "Resources" : isElectronBased(framework) ? "resources" : ""

      let asarIntegrity: AsarIntegrity | null = null
      if (!(asarOptions == null || options?.disableAsarIntegrity)) {
        asarIntegrity = await computeData({ resourcesPath, resourcesRelativePath, resourcesDestinationPath: this.getResourcesDir(appOutDir), extraResourceMatchers })
      }

      await framework.beforeCopyExtraFiles({
        packager: this,
        appOutDir,
        asarIntegrity,
        platformName,
      })
    }

    if (this.info.cancellationToken.cancelled) {
      return
    }

    const transformerForExtraFiles = this.createTransformerForExtraFiles(packContext)
    await copyFiles(extraResourceMatchers, transformerForExtraFiles)
    await copyFiles(extraFileMatchers, transformerForExtraFiles)

    if (this.info.cancellationToken.cancelled) {
      return
    }

    await this.info.emitAfterPack(packContext)

    if (framework.afterPack != null) {
      await framework.afterPack(packContext)
    }

    const isAsar = asarOptions != null
    await this.sanityCheckPackage(appOutDir, isAsar, framework, !!this.config.disableSanityCheckAsar)

    if (!options?.disableFuses) {
      await this.doAddElectronFuses(packContext)
    }
    if (options?.sign ?? true) {
      await this.doSignAfterPack(outDir, appOutDir, platformName, arch, platformSpecificBuildOptions, targets)
    }
  }

  // the fuses MUST be flipped right before signing
  protected async doAddElectronFuses(packContext: AfterPackContext) {
    if (this.config.electronFuses == null) {
      return
    }
    const fuseConfig = this.generateFuseConfig(this.config.electronFuses)
    await this.addElectronFuses(packContext, fuseConfig)
  }

  private generateFuseConfig(fuses: FuseOptionsV1): FuseV1Config {
    const config: FuseV1Config = {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: fuses.resetAdHocDarwinSignature,
    }
    // this is annoying, but we must filter out undefined entries because some older electron versions will receive `the fuse wire in this version of Electron is not long enough` even if entry is set undefined
    if (fuses.runAsNode != null) {
      config[FuseV1Options.RunAsNode] = fuses.runAsNode
    }
    if (fuses.enableCookieEncryption != null) {
      config[FuseV1Options.EnableCookieEncryption] = fuses.enableCookieEncryption
    }
    if (fuses.enableNodeOptionsEnvironmentVariable != null) {
      config[FuseV1Options.EnableNodeOptionsEnvironmentVariable] = fuses.enableNodeOptionsEnvironmentVariable
    }
    if (fuses.enableNodeCliInspectArguments != null) {
      config[FuseV1Options.EnableNodeCliInspectArguments] = fuses.enableNodeCliInspectArguments
    }
    if (fuses.enableEmbeddedAsarIntegrityValidation != null) {
      config[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] = fuses.enableEmbeddedAsarIntegrityValidation
    }
    if (fuses.onlyLoadAppFromAsar != null) {
      config[FuseV1Options.OnlyLoadAppFromAsar] = fuses.onlyLoadAppFromAsar
    }
    if (fuses.loadBrowserProcessSpecificV8Snapshot != null) {
      config[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot] = fuses.loadBrowserProcessSpecificV8Snapshot
    }
    if (fuses.grantFileProtocolExtraPrivileges != null) {
      config[FuseV1Options.GrantFileProtocolExtraPrivileges] = fuses.grantFileProtocolExtraPrivileges
    }
    return config
  }

  /**
   * Use `AfterPackContext` here to keep available for public API
   * @param {AfterPackContext} context
   * @param {FuseConfig} fuses
   *
   * Can be used in `afterPack` hook for custom fuse logic like below. It's an alternative approach if one wants to override electron-builder's @electron/fuses version
   * ```
   * await context.packager.addElectronFuses(context, { ... })
   * ```
   */
  public addElectronFuses(context: AfterPackContext, fuses: FuseConfig) {
    const { appOutDir, electronPlatformName } = context

    const ext = {
      darwin: ".app",
      mas: ".app",
      win32: ".exe",
      linux: "",
    }[electronPlatformName]

    const executableName = this instanceof LinuxPackager ? this.executableName : this.appInfo.productFilename
    const electronBinaryPath = path.join(appOutDir, `${executableName}${ext}`)

    log.info({ electronPath: log.filePath(electronBinaryPath) }, "executing @electron/fuses")
    return flipFuses(electronBinaryPath, fuses)
  }

  protected async doSignAfterPack(outDir: string, appOutDir: string, platformName: ElectronPlatformName, arch: Arch, platformSpecificBuildOptions: DC, targets: Array<Target>) {
    const asarOptions = await this.computeAsarOptions(platformSpecificBuildOptions)
    const isAsar = asarOptions != null
    const packContext = {
      appOutDir,
      outDir,
      arch,
      targets,
      packager: this,
      electronPlatformName: platformName,
    }
    const didSign = await this.signApp(packContext, isAsar)
    if (didSign) {
      await this.info.emitAfterSign(packContext)
    } else if (this.info.filterPackagerEventListeners("afterSign", "user").length) {
      log.warn(null, `skipping "afterSign" hook as no signing occurred, perhaps you intended "afterPack"?`)
    }
  }

  // eslint-disable-next-line
  protected createTransformerForExtraFiles(packContext: AfterPackContext): FileTransformer | null {
    return null
  }

  private copyAppFiles(
    taskManager: AsyncTaskManager,
    asarOptions: AsarOptions | null,
    resourcePath: string,
    defaultDestination: string,
    packContext: AfterPackContext,
    platformSpecificBuildOptions: DC,
    excludePatterns: Array<Minimatch>,
    macroExpander: (it: string) => string
  ) {
    const appDir = this.info.appDir
    const config = this.config
    const isElectronCompile = asarOptions != null && isElectronCompileUsed(this.info)

    const mainMatchers = getMainFileMatchers(appDir, defaultDestination, macroExpander, platformSpecificBuildOptions, this, packContext.outDir, isElectronCompile)
    if (excludePatterns.length > 0) {
      for (const matcher of mainMatchers) {
        matcher.excludePatterns = excludePatterns
      }
    }

    const framework = this.info.framework
    const transformer = createTransformer(
      appDir,
      config,
      isElectronCompile
        ? {
            originalMain: this.info.metadata.main,
            main: ELECTRON_COMPILE_SHIM_FILENAME,
            ...config.extraMetadata,
          }
        : config.extraMetadata,
      framework.createTransformer == null ? null : framework.createTransformer()
    )

    const _computeFileSets = (matchers: Array<FileMatcher>) => {
      return computeFileSets(matchers, this.info.isPrepackedAppAsar ? null : transformer, this, isElectronCompile).then(async result => {
        if (!this.info.isPrepackedAppAsar && !this.info.areNodeModulesHandledExternally) {
          const moduleFileMatcher = getNodeModuleFileMatcher(appDir, defaultDestination, macroExpander, platformSpecificBuildOptions, this.info)
          result = result.concat(await computeNodeModuleFileSets(this, moduleFileMatcher))
        }
        return result.filter(it => it.files.length > 0)
      })
    }

    if (this.info.isPrepackedAppAsar) {
      taskManager.add(async () => {
        const fileSets = await _computeFileSets([new FileMatcher(appDir, resourcePath, macroExpander)])
        fileSets.forEach(it => taskManager.addTask(copyAppFiles(it, this.info, transformer)))
        await taskManager.awaitTasks()
      })
    } else if (asarOptions == null) {
      // for ASAR all asar unpacked files will be extra transformed (e.g. sign of EXE and DLL) later,
      // for prepackaged asar extra transformation not supported yet,
      // so, extra transform if asar is disabled
      const transformerForExtraFiles = this.createTransformerForExtraFiles(packContext)
      const combinedTransformer: FileTransformer = file => {
        if (transformerForExtraFiles != null) {
          const result = transformerForExtraFiles(file)
          if (result != null) {
            return result
          }
        }
        return transformer(file)
      }
      taskManager.add(async () => {
        const fileSets = await _computeFileSets(mainMatchers)
        fileSets.forEach(it => taskManager.addTask(copyAppFiles(it, this.info, combinedTransformer)))
        await taskManager.awaitTasks()
      })
    } else {
      const unpackPattern = getFileMatchers(config, "asarUnpack", defaultDestination, {
        macroExpander,
        customBuildOptions: platformSpecificBuildOptions,
        globalOutDir: packContext.outDir,
        defaultSrc: appDir,
      })
      const fileMatcher = unpackPattern == null ? null : unpackPattern[0]
      taskManager.addTask(
        _computeFileSets(mainMatchers).then(async fileSets => {
          for (const fileSet of fileSets) {
            await transformFiles(transformer, fileSet)
          }

          await new AsarPackager(this, {
            defaultDestination,
            resourcePath,
            options: asarOptions,
            unpackPattern: fileMatcher?.createFilter(),
          }).pack(fileSets)
        })
      )
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected signApp(packContext: AfterPackContext, isAsar: boolean): Promise<boolean> {
    return Promise.resolve(false)
  }

  getIconPath(): Promise<string | null> {
    return Promise.resolve(null)
  }

  private async computeAsarOptions(customBuildOptions: DC): Promise<AsarOptions | null> {
    if (!isElectronBased(this.info.framework)) {
      return null
    }

    function errorMessage(name: string) {
      return `${name} is deprecated is deprecated and not supported — please use asarUnpack`
    }

    const buildMetadata = this.config as any
    if (buildMetadata["asar-unpack"] != null) {
      throw new Error(errorMessage("asar-unpack"))
    }
    if (buildMetadata["asar-unpack-dir"] != null) {
      throw new Error(errorMessage("asar-unpack-dir"))
    }

    const platformSpecific = customBuildOptions.asar
    const result = platformSpecific == null ? this.config.asar : platformSpecific
    if (result === false) {
      const appAsarStat = await statOrNull(path.join(this.info.appDir, "app.asar"))
      //noinspection ES6MissingAwait
      if (appAsarStat == null || !appAsarStat.isFile()) {
        log.warn(
          {
            solution: "enable asar and use asarUnpack to unpack files that must be externally available",
          },
          "asar usage is disabled — this is strongly not recommended"
        )
      }
      return null
    }

    if (result == null || result === true) {
      return {}
    }

    for (const name of ["unpackDir", "unpack"]) {
      if ((result as any)[name] != null) {
        throw new Error(errorMessage(`asar.${name}`))
      }
    }
    return deepAssign({}, result)
  }

  public getElectronSrcDir(dist: string): string {
    return path.resolve(this.projectDir, dist)
  }

  public getElectronDestinationDir(appOutDir: string): string {
    return appOutDir
  }

  getResourcesDir(appOutDir: string): string {
    if (this.platform === Platform.MAC) {
      return this.getMacOsResourcesDir(appOutDir)
    }
    if (isElectronBased(this.info.framework)) {
      return path.join(appOutDir, "resources")
    }
    return appOutDir
  }

  public getMacOsElectronFrameworkResourcesDir(appOutDir: string): string {
    const electronFrameworkName = path.basename(this.info.framework.distMacOsAppName, ".app") + " " + "Framework.framework"
    return path.join(appOutDir, `${this.appInfo.productFilename}.app`, "Contents", "Frameworks", electronFrameworkName, "Resources")
  }
  public getMacOsResourcesDir(appOutDir: string): string {
    return path.join(appOutDir, `${this.appInfo.productFilename}.app`, "Contents", "Resources")
  }

  private async checkFileInPackage(resourcesDir: string, file: string, messagePrefix: string, isAsar: boolean, disableSanityCheckAsar: boolean) {
    if (isAsar && disableSanityCheckAsar) {
      return
    }
    const relativeFile = path.relative(this.info.appDir, path.resolve(this.info.appDir, file))
    if (isAsar) {
      checkFileInArchive(path.join(resourcesDir, "app.asar"), relativeFile, messagePrefix)
      return
    }

    const pathParsed = path.parse(file)
    // Even when packaging to asar is disabled, it does not imply that the main file can not be inside an .asar archive.
    // This may occur when the packaging is done manually before processing with electron-builder.
    if (pathParsed.dir.includes(".asar")) {
      // The path needs to be split to the part with an asar archive which acts like a directory and the part with
      // the path to main file itself. (e.g. path/arch.asar/dir/index.js -> path/arch.asar, dir/index.js)
      // noinspection TypeScriptValidateJSTypes
      const pathSplit: Array<string> = pathParsed.dir.split(path.sep)
      let partWithAsarIndex = 0
      pathSplit.some((pathPart: string, index: number) => {
        partWithAsarIndex = index
        return pathPart.endsWith(".asar")
      })
      const asarPath = path.join(...pathSplit.slice(0, partWithAsarIndex + 1))
      let mainPath = pathSplit.length > partWithAsarIndex + 1 ? path.join.apply(pathSplit.slice(partWithAsarIndex + 1)) : ""
      mainPath += path.join(mainPath, pathParsed.base)
      checkFileInArchive(path.join(resourcesDir, "app", asarPath), mainPath, messagePrefix)
    } else {
      const fullPath = path.join(resourcesDir, "app", relativeFile)
      const outStat = await statOrNull(fullPath)
      if (outStat == null) {
        throw new Error(`${messagePrefix} "${fullPath}" does not exist. Seems like a wrong configuration.`)
      } else {
        //noinspection ES6MissingAwait
        if (!outStat.isFile()) {
          throw new Error(`${messagePrefix} "${fullPath}" is not a file. Seems like a wrong configuration.`)
        }
      }
    }
  }

  private async sanityCheckPackage(appOutDir: string, isAsar: boolean, framework: Framework, disableSanityCheckAsar: boolean): Promise<any> {
    const outStat = await statOrNull(appOutDir)
    if (outStat == null) {
      throw new Error(`Output directory "${appOutDir}" does not exist. Seems like a wrong configuration.`)
    } else {
      //noinspection ES6MissingAwait
      if (!outStat.isDirectory()) {
        throw new Error(`Output directory "${appOutDir}" is not a directory. Seems like a wrong configuration.`)
      }
    }

    const resourcesDir = this.getResourcesDir(appOutDir)
    const mainFile = (framework.getMainFile == null ? null : framework.getMainFile(this.platform)) || this.info.metadata.main || "index.js"
    await this.checkFileInPackage(resourcesDir, mainFile, "Application entry file", isAsar, disableSanityCheckAsar)
    await this.checkFileInPackage(resourcesDir, "package.json", "Application", isAsar, disableSanityCheckAsar)
  }

  // tslint:disable-next-line:no-invalid-template-strings
  computeSafeArtifactName(
    suggestedName: string | null,
    ext: string,
    arch?: Arch | null,
    skipDefaultArch = true,
    defaultArch?: string,
    safePattern = "${name}-${version}-${arch}.${ext}"
  ): string | null {
    return computeSafeArtifactNameIfNeeded(suggestedName, () =>
      this.computeArtifactName(safePattern, ext, skipDefaultArch && arch === defaultArchFromString(defaultArch) ? null : arch)
    )
  }

  expandArtifactNamePattern(
    targetSpecificOptions: TargetSpecificOptions | Nullish,
    ext: string,
    arch?: Arch | null,
    defaultPattern?: string,
    skipDefaultArch = true,
    defaultArch?: string
  ): string {
    const { pattern, isUserForced } = this.artifactPatternConfig(targetSpecificOptions, defaultPattern)
    return this.computeArtifactName(pattern, ext, !isUserForced && skipDefaultArch && arch === defaultArchFromString(defaultArch) ? null : arch)
  }

  artifactPatternConfig(targetSpecificOptions: TargetSpecificOptions | Nullish, defaultPattern: string | undefined) {
    const userSpecifiedPattern = targetSpecificOptions?.artifactName || this.platformSpecificBuildOptions.artifactName || this.config.artifactName
    return {
      isUserForced: !!userSpecifiedPattern,
      pattern: userSpecifiedPattern || defaultPattern || "${productName}-${version}-${arch}.${ext}",
    }
  }

  expandArtifactBeautyNamePattern(targetSpecificOptions: TargetSpecificOptions | Nullish, ext: string, arch?: Arch | null): string {
    // tslint:disable-next-line:no-invalid-template-strings
    return this.expandArtifactNamePattern(targetSpecificOptions, ext, arch, "${productName} ${version} ${arch}.${ext}", true)
  }

  private computeArtifactName(pattern: any, ext: string, arch: Arch | Nullish): string {
    const archName = arch == null ? null : getArtifactArchName(arch, ext)
    return this.expandMacro(pattern, archName, {
      ext,
    })
  }

  expandMacro(pattern: string, arch?: string | null, extra: any = {}, isProductNameSanitized = true): string {
    return doExpandMacro(pattern, arch, this.appInfo, { os: this.platform.buildConfigurationKey, ...extra }, isProductNameSanitized)
  }

  generateName2(ext: string | null, classifier: string | Nullish, deployment: boolean): string {
    const dotExt = ext == null ? "" : `.${ext}`
    const separator = ext === "deb" ? "_" : "-"
    return `${deployment ? this.appInfo.name : this.appInfo.productFilename}${separator}${this.appInfo.version}${classifier == null ? "" : `${separator}${classifier}`}${dotExt}`
  }

  getTempFile(suffix: string): Promise<string> {
    return this.info.tempDirManager.getTempFile({ suffix })
  }

  get fileAssociations(): Array<FileAssociation> {
    return asArray(this.config.fileAssociations).concat(asArray(this.platformSpecificBuildOptions.fileAssociations))
  }

  async getResource(custom: string | Nullish, ...names: Array<string>): Promise<string | null> {
    const resourcesDir = this.info.buildResourcesDir
    if (custom === undefined) {
      const resourceList = await this.resourceList
      for (const name of names) {
        if (resourceList.includes(name)) {
          return path.join(resourcesDir, name)
        }
      }
    } else if (custom != null && !isEmptyOrSpaces(custom)) {
      const resourceList = await this.resourceList
      if (resourceList.includes(custom)) {
        return path.join(resourcesDir, custom)
      }

      let p = path.resolve(resourcesDir, custom)
      if ((await statOrNull(p)) == null) {
        p = path.resolve(this.projectDir, custom)
        if ((await statOrNull(p)) == null) {
          throw new InvalidConfigurationError(
            `cannot find specified resource "${custom}", nor relative to "${resourcesDir}", neither relative to project dir ("${this.projectDir}")`
          )
        }
      }
      return p
    }
    return null
  }

  get forceCodeSigning(): boolean {
    const forceCodeSigningPlatform = this.platformSpecificBuildOptions.forceCodeSigning
    return (forceCodeSigningPlatform == null ? this.config.forceCodeSigning : forceCodeSigningPlatform) || false
  }

  protected async getOrConvertIcon(format: IconFormat): Promise<string | null> {
    const result = await this.resolveIcon(asArray(this.platformSpecificBuildOptions.icon || this.config.icon), [], format)
    if (result.length === 0) {
      const framework = this.info.framework
      if (framework.getDefaultIcon != null) {
        return framework.getDefaultIcon(this.platform)
      }

      log.warn({ reason: "application icon is not set" }, `default ${capitalizeFirstLetter(framework.name)} icon is used`)
      return this.getDefaultFrameworkIcon()
    } else {
      return result[0].file
    }
  }

  getDefaultFrameworkIcon(): string | null {
    const framework = this.info.framework
    return framework.getDefaultIcon == null ? null : framework.getDefaultIcon(this.platform)
  }

  // convert if need, validate size (it is a reason why tool is called even if file has target extension (already specified as foo.icns for example))
  async resolveIcon(sources: Array<string>, fallbackSources: Array<string>, outputFormat: IconFormat): Promise<Array<IconInfo>> {
    const output = this.expandMacro(this.config.directories!.output!)
    const args = [
      "icon",
      "--format",
      outputFormat,
      "--root",
      this.buildResourcesDir,
      "--root",
      this.projectDir,
      "--out",
      path.resolve(this.projectDir, output, `.icon-${outputFormat}`),
    ]
    for (const source of sources) {
      args.push("--input", source)
    }
    for (const source of fallbackSources) {
      args.push("--fallback-input", source)
    }

    const result: IconConvertResult = await executeAppBuilderAsJson(args)
    const errorMessage = result.error
    if (errorMessage != null) {
      throw new InvalidConfigurationError(errorMessage, result.errorCode)
    }

    if (result.isFallback) {
      log.warn({ reason: "application icon is not set" }, `default ${capitalizeFirstLetter(this.info.framework.name)} icon is used`)
    }

    return result.icons || []
  }
}

export interface IconInfo {
  file: string
  size: number
}

interface IconConvertResult {
  icons?: Array<IconInfo>

  error?: string
  errorCode?: string
  isFallback?: boolean
}

export type IconFormat = "icns" | "ico" | "set"

export function isSafeGithubName(name: string) {
  return /^[0-9A-Za-z._-]+$/.test(name)
}

export function computeSafeArtifactNameIfNeeded(suggestedName: string | null, safeNameProducer: () => string): string | null {
  // GitHub only allows the listed characters in file names.
  if (suggestedName != null) {
    if (isSafeGithubName(suggestedName)) {
      return null
    }

    // prefer to use suggested name - so, if space is the only problem, just replace only space to dash
    suggestedName = suggestedName.replace(/ /g, "-")
    if (isSafeGithubName(suggestedName)) {
      return suggestedName
    }
  }

  return safeNameProducer()
}

// remove leading dot
export function normalizeExt(ext: string) {
  return ext.startsWith(".") ? ext.substring(1) : ext
}

export function chooseNotNull<T>(v1: T | Nullish, v2: T | Nullish): T | Nullish {
  return v1 == null ? v2 : v1
}

function capitalizeFirstLetter(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
