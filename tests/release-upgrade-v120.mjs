import fs from 'node:fs/promises';import {pathToFileURL} from 'node:url';import path from 'node:path';
let source=await fs.readFile(new URL('./release-upgrade-v114.mjs',import.meta.url),'utf8');
source=source.replaceAll('review-1.1.3','v120').replaceAll('upgrade-v114','upgrade-v120')
 .replaceAll('1.1.4','1.2.0').replaceAll('1.1.3','1.1.6')
 .replaceAll('1\\.1\\.4','1\\.2\\.0').replaceAll('versionCode=8','versionCode=11').replaceAll('versionCode:8','versionCode:11');
await fs.mkdir('test-results/v120',{recursive:true});const file=path.resolve('test-results/v120/release-upgrade.generated.mjs');await fs.writeFile(file,source);await import(pathToFileURL(file).href);
