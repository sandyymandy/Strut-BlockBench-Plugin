/**
 * What the converter tells the person running it. Every finding names where it happened, so it can be acted on
 * <ul>
 * <li>{@code info}: something worth knowing that changes nothing</li>
 * <li>{@code changed}: the output differs from the input in a way that is deliberate and safe (a sign flip, a name normalised)</li>
 * <li>{@code lossy}: something in the input could not be carried over, or was replaced; the person should look</li>
 * </ul>
 */
export type Severity = 'info' | 'changed' | 'lossy';

export interface Finding {
    readonly severity: Severity;
    readonly message: string;
    readonly file?: string;
    readonly clip?: string;
    readonly bone?: string;
}

export class Findings {
    readonly items: Finding[] = [];

    add(severity: Severity, message: string, where: { file?: string; clip?: string; bone?: string } = {}): void {
        this.items.push({ severity, message, ...where });
    }

    get lossy(): number {
        return this.items.filter(item => item.severity === 'lossy').length;
    }
}

export function describeFinding(finding: Finding): string {
    const where = [finding.file, finding.clip && `clip "${finding.clip}"`, finding.bone && `bone "${finding.bone}"`]
        .filter(Boolean).join(', ');

    return where ? `${where}: ${finding.message}` : finding.message;
}
