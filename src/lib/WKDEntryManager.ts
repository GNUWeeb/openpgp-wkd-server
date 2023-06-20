import { emailRegex, mapItemRegex, pubKeyEntry, branch, repository } from "../constants.js";
import openpgp from "openpgp";
import { fetchContent } from "./util/fetchContent.js";
import { PubKey, PubKeySet } from "./PubKeySet.js";
import fetch from "node-fetch";

export class WKDEntryManager extends Map<EntryKey, PubKeySet> {
    public async loadKeys(): Promise<void> {
        // Get pubKeys files and raw entries
        const keys = await WKDEntryManager.getKeysURL();

        for (const [entry, pubKeysURLs] of keys.entries()) {
            // Resolve pubKeysURL
            const pubKeys = await Promise.all(Array.from(pubKeysURLs).map(url => WKDEntryManager.resolvePubKeyFile(url)))
                .then(p => p.filter((d): d is PubKey => d !== null));
            // Don't add entry if there are no keys
            if (pubKeys.length === 0) continue;

            this.set(entry, new PubKeySet(pubKeys, entry));
        }
    }

    public findEntryKey(fingerprint: string): EntryKey | undefined {
        for (const [entry, pubKeys] of this.entries()) {
            if (pubKeys.hasFingerprint(fingerprint)) return entry;
        }
        return undefined;
    }

    public hasPubKey(fingerprint: string): boolean { return this.findEntryKey(fingerprint) !== undefined; }

    public async updatePubKey(fingerprint: string, commitHash: string): Promise<[OldPubKey: PubKey, NewPubKey: PubKey]> {
        const pubKeys = this.get(this.findEntryKey(fingerprint)!);

        const newPubKey = await WKDEntryManager.resolvePubKeyFile(WKDEntryManager.pubKeyURL(commitHash, `${fingerprint}.asc`));
        if (!newPubKey) throw new Error(`Couldn't resolve pubKey for fingerprint ${fingerprint}`);

        const oldPubKey = pubKeys?.deleteFingerprint(fingerprint);
        if (!oldPubKey) throw new Error(`Couldn't find pubKey for fingerprint ${fingerprint}`);

        // @ts-expect-error False positive, there is no way this can be undefined
        pubKeys.add(oldPubKey);
        return [oldPubKey, newPubKey];
    }

    public deletePubKey(fingerprint: string): PubKey | undefined {
        const pubKeys = this.get(this.findEntryKey(fingerprint)!);
        const deleted = pubKeys?.deleteFingerprint(fingerprint);

        // Delete the entry if there are no more keys
        if (pubKeys?.size === 0) this.delete(pubKeys.entry);

        return deleted;
    }

    public get pubKeySize(): number { return Array.from(this.values()).reduce((acc, val) => acc + val.size, 0); }

    private static async resolvePubKeyFile(url: string): Promise<PubKey | null> {
        const res = await fetchContent(url);
        return res ? { etag: res.etag, data: await openpgp.readKey({ armoredKey: res.data }) } : null;
    }

    private static async getKeysURL(): Promise<WKDRawEntry> {
        const lastCommitHash = await this.getLastCommitHash();

        const map = await fetchContent(this.mapFileURL(lastCommitHash));
        if (!map) throw new Error("No map file found");

        const result = new Map() as WKDRawEntry;

        let match;
        while ((match = mapItemRegex.exec(map.data)) !== null) {
            const { UID: uid, wkdHash: entry, pubKeyFiles } = match.groups!;

            // Filter out emails that don't match our regex
            if (!emailRegex.test(uid)) continue;

            const pubKeyFilesURL = pubKeyFiles
                .split("\n")
                .filter(Boolean) // Filter out empty strings
                .map(p => p.substring(pubKeyEntry.length)) // Remove "P: " from the start
                .map(file => this.pubKeyURL(lastCommitHash, file)); // Convert to URL

            if (pubKeyFilesURL.length === 0) throw new Error(`No public keys found for UID ${uid} / Entry ${entry}`);

            if (result.has(entry)) {
                const data = result.get(entry)!;
                pubKeyFilesURL.forEach(url => data.add(url));
                result.set(entry, data);
            } else {
                result.set(entry, new Set(pubKeyFilesURL));
            }
        }

        return result;
    }

    private static async getLastCommitHash(): Promise<string> {
        const res = await fetch(`https://api.github.com/repos/${repository}/branches/${branch}`);
        if (!res.ok) throw new Error(`Failed to get last commit hash for branch ${branch}`);

        const data = await res.json() as Record<string, any>;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        return data.commit.sha;
    }

    private static mapFileURL(commitHash: string): string {
        return `https://raw.githubusercontent.com/${repository}/${commitHash}/map.txt`;
    }

    private static pubKeyURL(commitHash: string, pubkeyFile: string): string {
        return `https://raw.githubusercontent.com/${repository}/${commitHash}/keys/${pubkeyFile}`;
    }
}

export type EntryKey = string;
export type WKDRawEntry = Map<EntryKey, Set<string>>;
