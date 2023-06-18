import { emailRegex, mapFileURL, mapItemRegex, pubKeyURL, pubKeyEntry } from "../constants.js";
import openpgp from "openpgp";
import { Content, fetchContent } from "./util/fetchContent.js";
import { PubKeySet } from "./PubKeySet.js";

export class WKDEntryManager extends Map<EntryKey, PubKeySet> {
    public async loadKeys(): Promise<void> {
        // Get pubKeys files and raw entries
        const keys = await WKDEntryManager.getKeysURL();

        for (const [entry, pubKeysURLs] of keys.entries()) {
            // Resolve pubKeysURL
            const pubKeysData = (
                await Promise.all(
                    pubKeysURLs
                        .map(url => fetchContent(url)) // Fetch the content
                )
            ).filter((data): data is Content => data !== null);

            // Parse pubKeys
            const pubKeys = await Promise.all(
                pubKeysData
                    .map(async ({ etag, data }) => ({ etag, data: await openpgp.readKey({ armoredKey: data }) })) // Parse the key
            );

            // Don't add entry if there are no keys
            if (pubKeys.length === 0) continue;

            // Sort pubKeys by creation time (newest first)
            this.set(entry, new PubKeySet(pubKeys.sort((a, b) => b.data.getCreationTime().getTime() - a.data.getCreationTime().getTime())));
        }
    }

    public findEntryKey(fingerprint: string): EntryKey | undefined {
        for (const [entry, pubKeys] of this.entries()) {
            if (pubKeys.hasFingerprint(fingerprint)) return entry;
        }
        return undefined;
    }

    public hasPubKey(fingerprint: string): boolean {
        return this.findEntryKey(fingerprint) !== undefined;
    }

    private static async getKeysURL(): Promise<WKDRawEntry> {
        const map = await fetchContent(mapFileURL);
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
                .map(pubKeyURL); // Convert to URL

            if (pubKeyFilesURL.length === 0) throw new Error(`No public keys found for UID ${uid} / Entry ${entry}`);

            if (result.has(entry)) {
                const data = result.get(entry)!;
                data.push(...pubKeyFilesURL);
                result.set(entry, data);
            } else {
                result.set(entry, pubKeyFilesURL);
            }
        }

        return result;
    }
}

export type EntryKey = string;
export type PublicKeyURL = URL;
export type WKDRawEntry = Map<EntryKey, PublicKeyURL[]>;
