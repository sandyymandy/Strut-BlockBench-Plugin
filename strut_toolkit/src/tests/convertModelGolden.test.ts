import * as fs from 'fs';
import * as path from 'path';
import { convertGeoFile } from '../ts/convert/geoToRaw';
import { encodeModel } from '../ts/binary/model';

/**
 * The golden models the Java oracle test reads: `src/test/resources/converter/<name>.geo.json` converted to `<name>.strutmodel` by this converter.
 * Fails when the converter's output for a fixture changes; regenerate on purpose with `WRITE_GOLDEN=1 npx jest tests/convertModelGolden` and commit the result
 */
const DIR = path.resolve(__dirname, '../../../../src/test/resources/converter');

describe('converter golden models', () => {
    for (const name of ['shapes', 'girl_staff', 'girl_bed']) {
        it(`${name}.strutmodel is what the converter writes for ${name}.geo.json`, () => {
            const source = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.geo.json`), 'utf8'));
            const bytes = encodeModel(convertGeoFile(source, { file: `${name}.geo.json` }).model);
            const golden = path.join(DIR, `${name}.strutmodel`);

            if (process.env.WRITE_GOLDEN)
                fs.writeFileSync(golden, bytes);

            expect(Buffer.from(bytes).equals(fs.readFileSync(golden))).toBe(true);
        });
    }
});
