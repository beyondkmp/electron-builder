import { DIR_TARGET, Platform } from "app-builder-lib"
import { readAsar } from "app-builder-lib/out/asar/asar"
import { outputFile } from "fs-extra"
import * as path from "path"
import * as fs from "fs/promises"
import { assertThat } from "./helpers/fileAssert"
import { app, appThrows, assertPack, modifyPackageJson, PackedContext, removeUnstableProperties, verifyAsarFileTree } from "./helpers/packTester"
import { verifySmartUnpack } from "./helpers/verifySmartUnpack"

async function createFiles(appDir: string) {
  await Promise.all([
    outputFile(path.join(appDir, "assets", "file1"), "data"),
    outputFile(path.join(appDir, "assets", "file2"), "data"),
    outputFile(path.join(appDir, "assets", "subdir", "file3"), "data"),
    outputFile(path.join(appDir, "b2", "file"), "data"),
    outputFile(path.join(appDir, "do-not-unpack-dir", "file.json"), "{}").then(() => fs.writeFile(path.join(appDir, "do-not-unpack-dir", "must-be-not-unpacked"), "{}")),
  ])

  const dir = path.join(appDir, "do-not-unpack-dir", "dir-2", "dir-3", "dir-3")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "file-in-asar"), "{}")

  await fs.symlink(path.join(appDir, "assets", "file1"), path.join(appDir, "assets", "subdir", "file-symlink1")) // "reverse" symlink up one directory
  await fs.symlink(path.join(appDir, "assets", "file2"), path.join(appDir, "assets", "file-symlink2")) // same dir symlink
  await fs.symlink(path.join(appDir, "assets", "subdir", "file3"), path.join(appDir, "file-symlink3")) // symlink down
}

test.ifNotWindows.ifDevOrLinuxCi(
  "unpackDir one",
  app(
    {
      targets: Platform.LINUX.createTarget(DIR_TARGET),
      config: {
        asarUnpack: ["assets", "b2", "do-not-unpack-dir/file.json"],
      },
    },
    {
      projectDirCreated: createFiles,
      packed: assertDirs,
    }
  )
)

async function assertDirs(context: PackedContext) {
  const resourceDir = context.getResources(Platform.LINUX)
  await Promise.all([
    assertThat(path.join(resourceDir, "app.asar.unpacked", "assets")).isDirectory(),
    assertThat(path.join(resourceDir, "app.asar.unpacked", "b2")).isDirectory(),
    assertThat(path.join(resourceDir, "app.asar.unpacked", "do-not-unpack-dir", "file.json")).isFile(),
    assertThat(path.join(resourceDir, "app.asar.unpacked", "do-not-unpack-dir", "must-be-not-unpacked")).doesNotExist(),
    assertThat(path.join(resourceDir, "app.asar.unpacked", "do-not-unpack-dir", "dir-2")).doesNotExist(),
  ])

  await verifyAsarFileTree(resourceDir)
}

test.ifNotWindows.ifDevOrLinuxCi("unpackDir", () => {
  return assertPack(
    "test-app",
    {
      targets: Platform.LINUX.createTarget(DIR_TARGET),
      config: {
        asarUnpack: ["assets", "b2", "do-not-unpack-dir/file.json"],
      },
    },
    {
      projectDirCreated: projectDir => createFiles(path.join(projectDir, "app")),
      packed: assertDirs,
    }
  )
})

test.ifDevOrLinuxCi("asarUnpack and files ignore", () => {
  return assertPack(
    "test-app",
    {
      targets: Platform.LINUX.createTarget(DIR_TARGET),
      config: {
        asarUnpack: ["!**/ffprobe-static/bin/darwin/x64/ffprobe"],
      },
    },
    {
      projectDirCreated: projectDir => outputFile(path.join(projectDir, "node_modules/ffprobe-static/bin/darwin/x64/ffprobe"), "data"),
      packed: async context => {
        const resourceDir = context.getResources(Platform.LINUX)
        await Promise.all([assertThat(path.join(resourceDir, "app.asar.unpacked", "node_modules/ffprobe-static/bin/darwin/x64/ffprobe")).doesNotExist()])

        await verifyAsarFileTree(context.getResources(Platform.LINUX))
      },
    }
  )
})

test.ifNotWindows(
  "link",
  app(
    {
      targets: Platform.LINUX.createTarget(DIR_TARGET),
    },
    {
      projectDirCreated: projectDir => {
        return fs.symlink(path.join(projectDir, "index.js"), path.join(projectDir, "foo.js"))
      },
      packed: async context => {
        expect((await readAsar(path.join(context.getResources(Platform.LINUX), "app.asar"))).getFile("foo.js", false)).toMatchSnapshot()
      },
    }
  )
)

test.ifNotWindows(
  "outside link",
  appThrows(
    {
      targets: Platform.LINUX.createTarget(DIR_TARGET),
    },
    {
      projectDirCreated: async (projectDir, tmpDir) => {
        const tempDir = await tmpDir.getTempDir()
        await outputFile(path.join(tempDir, "foo"), "data")
        await fs.symlink(tempDir, path.join(projectDir, "o-dir"))
      },
    }
  )
)

test.ifDevOrLinuxCi("local node module with file protocol", () => {
  return assertPack(
    "test-app-one",
    {
      targets: Platform.LINUX.createTarget(DIR_TARGET),
      config: {
        asarUnpack: ["**/node_modules/foo/**/*"],
      },
    },
    {
      isInstallDepsBefore: true,
      projectDirCreated: async (projectDir, tmpDir) => {
        const tempDir = await tmpDir.getTempDir()
        let localPath = path.join(tempDir, "foo")
        await outputFile(path.join(localPath, "package.json"), `{"name":"foo","version":"9.0.0","main":"index.js","license":"MIT","dependencies":{"ms":"2.0.0"}}`)
        await modifyPackageJson(projectDir, data => {
          data.dependencies = {
            foo: `file:${localPath}`,
          }
        })
      },
      packed: async context => {
        assertThat(path.join(path.join(context.getResources(Platform.LINUX), "app.asar.unpacked", "node_modules", "foo", "package.json"))).isFile()
      },
    }
  )
})

// cannot be enabled
// https://github.com/electron-userland/electron-builder/issues/611
test.ifDevOrLinuxCi("failed peer dep", () => {
  return assertPack(
    "test-app-one",
    {
      targets: Platform.LINUX.createTarget(DIR_TARGET),
    },
    {
      isInstallDepsBefore: true,
      projectDirCreated: projectDir =>
        modifyPackageJson(projectDir, data => {
          //noinspection SpellCheckingInspection
          data.dependencies = {
            debug: "4.1.1",
            "rc-datepicker": "4.0.0",
            react: "15.2.1",
            "react-dom": "15.2.1",
          }
        }),
      packed: context => {
        return verifySmartUnpack(context.getResources(Platform.LINUX))
      },
    }
  )
})

test.ifAll.ifDevOrLinuxCi("ignore node_modules", () => {
  return assertPack(
    "test-app-one",
    {
      targets: Platform.LINUX.createTarget(DIR_TARGET),
      config: {
        asar: false,
        files: ["!node_modules/**/*"],
      },
    },
    {
      isInstallDepsBefore: true,
      projectDirCreated: projectDir =>
        modifyPackageJson(projectDir, data => {
          //noinspection SpellCheckingInspection
          data.dependencies = {
            "ci-info": "2.0.0",
            "@types/node": "14.17.0",
            // this contains string-width-cjs 4.2.3
            "@isaacs/cliui": "8.0.2",
          }
        }),
      packed: context => {
        return assertThat(path.join(context.getResources(Platform.LINUX), "app", "node_modules")).doesNotExist()
      },
    }
  )
})

test.ifAll.ifDevOrLinuxCi("asarUnpack node_modules", () => {
  return assertPack(
    "test-app-one",
    {
      targets: Platform.LINUX.createTarget(DIR_TARGET),
      config: {
        asarUnpack: "node_modules",
      },
    },
    {
      isInstallDepsBefore: true,
      projectDirCreated: projectDir =>
        modifyPackageJson(projectDir, data => {
          data.dependencies = {
            "ci-info": "2.0.0",
          }
        }),
      packed: async context => {
        const nodeModulesNode = (await readAsar(path.join(context.getResources(Platform.LINUX), "app.asar"))).getNode("node_modules")
        expect(removeUnstableProperties(nodeModulesNode)).toMatchSnapshot()
        await assertThat(path.join(context.getResources(Platform.LINUX), "app.asar.unpacked/node_modules/ci-info")).isDirectory()
      },
    }
  )
})
