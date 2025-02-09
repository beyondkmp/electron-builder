
import { sign } from '@electron/windows-sign';
import fs from 'fs-extra';
import path from 'path';

const logPath = path.join('electron-windows-sign.log');
const options = JSON.parse(process.argv[2]);
const signArgv = JSON.parse(process.argv[3]);
const files = signArgv.slice(-1);

fs.appendFileSync(logPath, `\n${files}`);
sign({ ...options, files })
  .then((result) => {
    fs.appendFileSync(logPath, `\n${result}`);
    console.log(`Successfully signed ${files}`, result);
  })
  .catch((error) => {
    fs.appendFileSync(logPath, `\n${error}`);
    throw new Error(error);
  });
