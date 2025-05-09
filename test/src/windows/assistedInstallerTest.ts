import { Arch, archFromString, Platform } from "electron-builder"
import * as fs from "fs/promises"
import * as path from "path"
import { app, assertPack, copyTestAsset } from "../helpers/packTester"
import { checkHelpers, doTest, expectUpdateMetadata } from "../helpers/winHelper"

const nsisTarget = Platform.WINDOWS.createTarget(["nsis"])

test.ifNotCiMac("assisted", ({ expect }) =>
  app(
    expect,
    {
      targets: nsisTarget,
      config: {
        nsis: {
          oneClick: false,
          language: "1031",
        },
        win: {
          legalTrademarks: "My Trademark",
        },
        electronFuses: {
          runAsNode: true,
          enableCookieEncryption: true,
          enableNodeOptionsEnvironmentVariable: true,
          enableNodeCliInspectArguments: true,
          enableEmbeddedAsarIntegrityValidation: true,
          onlyLoadAppFromAsar: true,
          loadBrowserProcessSpecificV8Snapshot: true,
          grantFileProtocolExtraPrivileges: undefined, // unsupported on current electron version in our tests
        },
      },
    },
    {
      signedWin: true,
      projectDirCreated: projectDir => copyTestAsset("license.txt", path.join(projectDir, "build", "license.txt")),
    }
  )
)

test.ifNotCiMac("allowElevation false, app requestedExecutionLevel admin", ({ expect }) =>
  app(expect, {
    targets: nsisTarget,
    config: {
      publish: null,
      extraMetadata: {
        // mt.exe doesn't like unicode names from wine
        name: "test",
        productName: "test",
      },
      win: {
        requestedExecutionLevel: "requireAdministrator",
      },
      nsis: {
        oneClick: false,
        allowElevation: false,
        perMachine: true,
        displayLanguageSelector: true,
        installerLanguages: ["en_US", "ru_RU"],
        differentialPackage: false,
      },
    },
  })
)

test.ifNotCiMac("assisted, MUI_HEADER", ({ expect }) => {
  let installerHeaderPath: string | null = null
  return assertPack(
    expect,
    "test-app-one",
    {
      targets: nsisTarget,
      config: {
        publish: null,
        nsis: {
          oneClick: false,
          differentialPackage: false,
        },
      },
      effectiveOptionComputed: async it => {
        const defines = it[0]
        expect(defines.MUI_HEADERIMAGE).toBeNull()
        expect(defines.MUI_HEADERIMAGE_BITMAP).toEqual(installerHeaderPath)
        expect(defines.MUI_HEADERIMAGE_RIGHT).toBeNull()
        // speedup, do not build - another MUI_HEADER test will test build
        return true
      },
    },
    {
      projectDirCreated: projectDir => {
        installerHeaderPath = path.join(projectDir, "build", "installerHeader.bmp")
        return copyTestAsset("installerHeader.bmp", installerHeaderPath)
      },
    }
  )
})

test.ifNotCiMac("assisted, MUI_HEADER as option", ({ expect }) => {
  let installerHeaderPath: string | null = null
  return assertPack(
    expect,
    "test-app-one",
    {
      targets: Platform.WINDOWS.createTarget(["nsis"], Arch.ia32, Arch.x64),
      config: {
        publish: null,
        nsis: {
          oneClick: false,
          installerHeader: "foo.bmp",
          differentialPackage: false,
        },
      },
      effectiveOptionComputed: async it => {
        const defines = it[0]
        expect(defines.MUI_HEADERIMAGE).toBeNull()
        expect(defines.MUI_HEADERIMAGE_BITMAP).toEqual(installerHeaderPath)
        expect(defines.MUI_HEADERIMAGE_RIGHT).toBeNull()
        // test that we can build such installer
        return false
      },
    },
    {
      projectDirCreated: projectDir => {
        installerHeaderPath = path.join(projectDir, "foo.bmp")
        return copyTestAsset("installerHeader.bmp", installerHeaderPath)
      },
    }
  )
})

test.ifNotCiMac.skip("debug logging enabled", ({ expect }) =>
  app(expect, {
    targets: nsisTarget,
    config: {
      nsis: {
        customNsisBinary: {
          url: "https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.2/nsis-3.0.4.2.7z",
          version: "3.0.4.2",
          checksum: "o+YZsXHp8LNihhuk7JsCDhdIgx0MKKK+1b3sGD+4zX5djZULe4/4QMcAsfQ+0r+a8FnwBt7BVBHkIkJHjKQ0sg==",
          debugLogging: true,
        },
      },
    },
  })
)

test.ifNotCiMac("assisted, only perMachine", ({ expect }) =>
  app(expect, {
    targets: nsisTarget,
    config: {
      nsis: {
        oneClick: false,
        perMachine: true,
      },
    },
  })
)

test.ifNotCiMac("assisted, only perMachine and elevated", ({ expect }) =>
  app(expect, {
    targets: nsisTarget,
    config: {
      nsis: {
        oneClick: false,
        perMachine: true,
        packElevateHelper: true,
      },
    },
  })
)

// test release notes also
test.ifNotCiMac("allowToChangeInstallationDirectory", ({ expect }) =>
  app(
    expect,
    {
      targets: nsisTarget,
      config: {
        extraMetadata: {
          name: "test-custom-inst-dir",
          productName: "Test Custom Installation Dir",
          repository: "foo/bar",
        },
        nsis: {
          allowToChangeInstallationDirectory: true,
          oneClick: false,
          multiLanguageInstaller: false,
        },
      },
    },
    {
      projectDirCreated: async projectDir => {
        await fs.writeFile(path.join(projectDir, "build", "release-notes.md"), "New release with new bugs and\n\nwithout features")
        await copyTestAsset("license.txt", path.join(projectDir, "build", "license.txt"))
      },
      packed: async context => {
        await expectUpdateMetadata(expect, context, archFromString(process.arch))
        await checkHelpers(expect, context.getResources(Platform.WINDOWS), true)
        await doTest(expect, context.outDir, false)
      },
    }
  )
)
