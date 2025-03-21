import { NpmNodeModulesCollector } from "./npmNodeModulesCollector"
import { PnpmNodeModulesCollector } from "./pnpmNodeModulesCollector"
import { YarnNodeModulesCollector } from "./yarnNodeModulesCollector"
import { detect, PM, getPackageManagerVersion } from "./packageManager"
import { NodeModuleInfo } from "./types"
import { exec } from "builder-util"
import * as path from "path"
import { Dependency } from "./types"

async function isPnpmProjectHoisted(rootDir: string) {
  const command = await PnpmNodeModulesCollector.pmCommand.value
  const config = await exec(command, ["config", "list"], { cwd: rootDir, shell: true })
  const lines = Object.fromEntries(config.split("\n").map(line => line.split("=").map(s => s.trim())))
  return lines["node-linker"] === "hoisted"
}

export async function getCollectorByPackageManager(rootDir: string, realDependencies?: Record<string, string>) {
  const manager: PM = await detect({ cwd: rootDir })
  switch (manager) {
    case "pnpm":
      if (await isPnpmProjectHoisted(rootDir)) {
        return new NpmNodeModulesCollector(rootDir, realDependencies)
      }
      return new PnpmNodeModulesCollector(rootDir, realDependencies)
    case "npm":
      return new NpmNodeModulesCollector(rootDir, realDependencies)
    case "yarn":
      return new YarnNodeModulesCollector(rootDir, realDependencies)
    default:
      return new NpmNodeModulesCollector(rootDir, realDependencies)
  }
}

export async function getNodeModules(appDir: string, projectDir?: string): Promise<NodeModuleInfo[]> {
  if (!projectDir) {
    return (await getCollectorByPackageManager(appDir)).getNodeModules()
  }

  const projectPackageJson: Dependency<string, string> = require(path.join(projectDir, "package.json"))

  if (projectPackageJson.workspaces) {
    return (await getCollectorByPackageManager(appDir)).getNodeModules()
  }

  const appPackageJson: Dependency<string, string> = require(path.join(appDir, "package.json"))
  if (appPackageJson.dependencies) {
    return (await getCollectorByPackageManager(projectDir, appPackageJson.dependencies)).getNodeModules()
  }

  return (await getCollectorByPackageManager(projectDir)).getNodeModules()
}

export { detect, getPackageManagerVersion, PM }
