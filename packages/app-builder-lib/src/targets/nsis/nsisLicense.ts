import { lcid } from "../../util/langs"
import { getLicenseFiles, getNotLocalizedLicenseFile } from "../../util/license"
import * as path from "path"
import { WinPackager } from "../../winPackager"
import { NsisOptions } from "./nsisOptions"
import { NsisScriptGenerator } from "./nsisScriptGenerator"
import { nsisTemplatesDir } from "./nsisUtil"
import * as fs from "fs"

function convertFileToUtf8WithBOMSync(filePath: string): boolean {
  try {
    const data = fs.readFileSync(filePath)
    // UTF-8 BOM is EF BB BF
    const BOM = Buffer.from([0xef, 0xbb, 0xbf])
    const dataWithBOM = Buffer.concat([BOM, data])
    fs.writeFileSync(filePath, dataWithBOM)
    return true
  } catch (err) {
    console.error("Failed to convert file to UTF-8 with BOM: ", err)
    return false
  }
}
export async function computeLicensePage(packager: WinPackager, options: NsisOptions, scriptGenerator: NsisScriptGenerator, languages: Array<string>): Promise<void> {
  const license = await getNotLocalizedLicenseFile(options.license, packager)
  if (license != null) {
    let licensePage: Array<string>
    if (license.endsWith(".html")) {
      licensePage = [
        "!define MUI_PAGE_CUSTOMFUNCTION_SHOW LicenseShow",
        "Function LicenseShow",
        "  FindWindow $R0 `#32770` `` $HWNDPARENT",
        "  GetDlgItem $R0 $R0 1000",
        "EmbedHTML::Load /replace $R0 file://$PLUGINSDIR\\license.html",
        "FunctionEnd",

        `!insertmacro MUI_PAGE_LICENSE "${path.join(nsisTemplatesDir, "empty-license.txt")}"`,
      ]
    } else {
      licensePage = [`!insertmacro MUI_PAGE_LICENSE "${license}"`]
    }

    scriptGenerator.macro("licensePage", licensePage)
    if (license.endsWith(".html")) {
      scriptGenerator.macro("addLicenseFiles", [`File /oname=$PLUGINSDIR\\license.html "${license}"`])
    }
    return
  }

  const licenseFiles = await getLicenseFiles(packager)
  if (licenseFiles.length === 0) {
    return
  }

  const licensePage: Array<string> = []
  const unspecifiedLangs = new Set(languages)

  let defaultFile: string | null = null
  for (const item of licenseFiles) {
    unspecifiedLangs.delete(item.langWithRegion)
    convertFileToUtf8WithBOMSync(item.file)
    if (defaultFile == null) {
      defaultFile = item.file
    }
    licensePage.push(`LicenseLangString MUILicense ${lcid[item.langWithRegion] || item.lang} "${item.file}"`)
  }

  for (const l of unspecifiedLangs) {
    licensePage.push(`LicenseLangString MUILicense ${lcid[l]} "${defaultFile}"`)
  }

  licensePage.push('!insertmacro MUI_PAGE_LICENSE "$(MUILicense)"')
  scriptGenerator.macro("licensePage", licensePage)
}
