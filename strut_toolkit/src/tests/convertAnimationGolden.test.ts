import * as fs from 'fs';
import * as path from 'path';
import { convertAnimationFile } from '../ts/convert/animationToRaw';
import { decodeAnimation, encodeAnimation } from '../ts/binary/animation';

/**
 * The golden files the Java tests read: `src/test/resources/converter/<name>.animation.json` converted to `<name>.strutanim` by this converter.
 * This test fails when the converter's output for a fixture changes; regenerate on purpose with `WRITE_GOLDEN=1 npx jest tests/convertAnimationGolden`
 * and commit the new `.strutanim`, so the Java side (BinaryAnimationConverterGoldenTest) is checked against the same bytes
 */
const DIR = path.resolve(__dirname, '../../../../src/test/resources/converter');
const FINGERPRINT = 0x1234abcd | 0;

describe('converter golden files', () => {
    for (const name of ['pose', 'events', 'order']) {
        it(`${name}.strutanim is what the converter writes for ${name}.animation.json`, () => {
            const source = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.animation.json`), 'utf8'));
            const bytes = encodeAnimation(convertAnimationFile(source, { file: `${name}.animation.json`, skeletonFingerprint: FINGERPRINT }).animation);
            const golden = path.join(DIR, `${name}.strutanim`);

            if (process.env.WRITE_GOLDEN)
                fs.writeFileSync(golden, bytes);

            expect(Buffer.from(bytes).equals(fs.readFileSync(golden))).toBe(true);
        });
    }

    it('order.strutanim keeps the clips in the order the source file lists them (not sorted, not reordered)', () => {
        const text = fs.readFileSync(path.join(DIR, 'order.animation.json'), 'utf8');
        // The order in the source text itself, read without a JSON parser, so the check does not share a parser's key ordering with the converter
        const inSource = [...text.matchAll(/"(animation\.[^"]+)"\s*:\s*\{\s*"(?:loop|animation_length)"/g)].map(m => m[1]);
        const converted = convertAnimationFile(JSON.parse(text), { file: 'order.animation.json', skeletonFingerprint: FINGERPRINT }).animation;
        const decoded = decodeAnimation(fs.readFileSync(path.join(DIR, 'order.strutanim')), 'order.strutanim');

        expect(inSource).toEqual(['animation.zeta.walk', 'animation.alpha.idle', 'animation.mid.run', 'animation.base.talk_horny', 'animation.alpha.blink']);
        expect(converted.clips.map(c => c.name)).toEqual(inSource);
        expect(decoded.clips.map(c => c.name)).toEqual(inSource);
    });
});
