import { NpmNodeModulesCollector } from "./npmNodeModulesCollector"

export class YarnNodeModulesCollector extends NpmNodeModulesCollector {
  constructor(rootDir: string, includedDependencies?: Record<string, string>) {
    super(rootDir, includedDependencies)
  }

  public readonly installOptions = Promise.resolve({
    cmd: process.platform === "win32" ? "yarn.cmd" : "yarn",
    args: ["install", "--frozen-lockfile"],
    lockfile: "yarn.lock",
  })
}
