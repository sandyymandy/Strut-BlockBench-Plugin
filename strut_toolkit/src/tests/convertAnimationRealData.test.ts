import * as fs from 'fs';
import * as path from 'path';
import { convertAnimationFile } from '../ts/convert/animationToRaw';
import { decodeAnimation, encodeAnimation } from '../ts/binary/animation';

/**
 * Smoke test on the real Pleasure Horizons files, when that repository sits next to this one (skipped otherwise): every legacy animation
 * file must convert, encode, and decode back to the same clips, keys and events. Prints a one-line summary per run so the size of the job is visible
 */
const PH = path.resolve(__dirname, '../../../../../Pleasure Horizons/asset_sources/animations');

function animationFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);

        return entry.isDirectory() ? animationFiles(full) : /\.(animation|scene)\.json$/.test(entry.name) ? [full] : [];
    });
}

const describeIfPresent = fs.existsSync(PH) ? describe : describe.skip;

describeIfPresent('the real Pleasure Horizons animation files', () => {
    it('every file converts, encodes and decodes back to the same clips, keys and events', () => {
        const files = animationFiles(PH);
        let clips = 0;
        let keys = 0;
        let events = 0;
        let lossy = 0;

        expect(files.length).toBeGreaterThan(20);

        for (const file of files) {
            const { animation, findings } = convertAnimationFile(JSON.parse(fs.readFileSync(file, 'utf8')), { file: path.basename(file) });
            const decoded = decodeAnimation(encodeAnimation(animation), file);

            expect(decoded.clips.map(c => c.name)).toEqual(animation.clips.map(c => c.name));

            animation.clips.forEach((clip, i) => {
                const back = decoded.clips[i];

                expect(back.channels.length).toBe(clip.channels.length);
                expect(back.events.map(e => [e.kind, e.payload])).toEqual(clip.events.map(e => [e.kind, e.payload]));
                back.events.forEach((e, n) => expect(e.time).toBeCloseTo(clip.events[n].time, 4)); // times are 32-bit floats on the wire
                clip.channels.forEach((channel, j) => {
                    expect(back.channels[j].keys.length).toBe(channel.keys.length);
                    channel.keys.forEach((key, k) => {
                        const other = back.channels[j].keys[k];

                        expect(other.easing).toBe(key.easing);
                        expect(other.value.expressions).toEqual(key.value.expressions);
                        key.value.literals.forEach((value, axis) => expect(other.value.literals[axis]).toBeCloseTo(value, 4));
                    });
                    keys += channel.keys.length;
                });
                events += clip.events.length;
            });

            clips += animation.clips.length;
            lossy += findings.lossy;
        }

        console.log(`PH animations: ${files.length} files, ${clips} clips, ${keys} keys, ${events} events, ${lossy} lossy findings`);
    });
});
