import * as fs from 'fs';
import * as path from 'path';
import { convertGeoFile } from '../ts/convert/geoToRaw';
import { decodeModel, encodeModel } from '../ts/binary/model';

/**
 * Smoke test on the real Pleasure Horizons models, when that repository sits next to this one (skipped otherwise): every legacy model must convert, encode
 * and decode back to the same bones and cubes. With `WRITE_ORACLE_DIR=<dir>` it also writes each converted file there (keeping the `geo/...` layout) for the
 * Java oracle test to read (`STRUT_ORACLE_OUT=<dir>`)
 */
const PH = path.resolve(__dirname, '../../../../../Pleasure Horizons/asset_sources/geo');

function geoFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);

        return entry.isDirectory() ? geoFiles(full) : entry.name.endsWith('.geo.json') ? [full] : [];
    });
}

const describeIfPresent = fs.existsSync(PH) ? describe : describe.skip;

describeIfPresent('the real Pleasure Horizons model files', () => {
    it('every file converts, encodes and decodes back to the same bones and cubes', () => {
        const files = geoFiles(PH);
        let bones = 0;
        let cubes = 0;
        let lossy = 0;

        expect(files.length).toBeGreaterThan(20);

        for (const file of files) {
            const { model, findings } = convertGeoFile(JSON.parse(fs.readFileSync(file, 'utf8')), { file: path.basename(file) });
            const bytes = encodeModel(model);
            const back = decodeModel(bytes, file);

            expect(back.groupBones.map(b => b.name)).toEqual(model.groupBones.map(b => b.name));
            expect(back.groupBones.map(b => b.parentIndex)).toEqual(model.groupBones.map(b => b.parentIndex));
            expect(back.cubes.length).toBe(model.cubes.length);
            expect(back.cubes.map(c => c.faces.length)).toEqual(model.cubes.map(c => c.faces.length));
            bones += model.groupBones.length;
            cubes += model.cubes.length;
            lossy += findings.lossy;

            if (process.env.WRITE_ORACLE_DIR) {
                const out = path.join(process.env.WRITE_ORACLE_DIR, path.relative(PH, file).replace(/\.geo\.json$/, '.strutmodel'));

                fs.mkdirSync(path.dirname(out), { recursive: true });
                fs.writeFileSync(out, bytes);
            }
        }

        console.log(`PH models: ${files.length} files, ${bones} bones, ${cubes} cubes, ${lossy} lossy findings`);
    });
});
