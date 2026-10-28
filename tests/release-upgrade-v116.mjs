// Reuse the native-only signed upgrade scenario, changing only the baseline and version assertions.
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
let source=await fs.readFile(new URL('./release-upgrade-v114.mjs',import.meta.url),'utf8');
source=source.replaceAll('review-1.1.3','review-1.1.5').replaceAll('upgrade-v114','upgrade-v116')
 .replaceAll('1.1.4','1.1.6').replaceAll('1.1.3','1.1.5')
 .replaceAll('1\\.1\\.4','1\\.1\\.6').replaceAll('versionCode=8','versionCode=10').replaceAll('versionCode:8','versionCode:10');
await fs.mkdir('test-results/review-1.1.5',{recursive:true});
const file=path.resolve('test-results/review-1.1.5/release-upgrade.generated.mjs');await fs.writeFile(file,source);
await import(pathToFileURL(file).href);
