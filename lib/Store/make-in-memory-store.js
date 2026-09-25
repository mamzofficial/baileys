import * as WAProto_1 from "../../WAProto/index.js";
import * as Defaults_1 from "../Defaults/index.js";
import { LabelAssociationType } from "../Types/LabelAssociation.js";
import * as Utils_1 from "../Utils/index.js";
import * as WABinary_1 from "../WABinary/index.js";
import makeOrderedDictionary from "./make-ordered-dictionary.js";
import { ObjectRepository } from "./object-repository.js";
import KeyedDB from "./keyed-db.js";
import { existsSync, readFileSync, writeFileSync } from "fs";

// BUG FIX (see keyed-db.js's insert() for the full story): `key` used to
// return a composite string (pin flag + archive flag + hex timestamp + id)
// that doubled as BOTH the KeyedDB dict-lookup id AND the sort-priority
// encoding. That broke `chats.get(jid)` / `.update(jid, ...)` /
// `.deleteById(jid)` for every caller passing a plain JID (which is every
// caller in this codebase) — `_dict` was keyed by the composite string, so a
// plain-JID lookup never matched. `key` is now just the plain chat id;
// `compare` does the actual pin/archived/most-recent-first ordering
// directly on two full chat entries, preserving the exact same sort order
// as before (pinned first, then non-archived first, then newest
// conversationTimestamp first, id as the final tie-break to match the old
// descending-string-compare behavior).
const waChatKey = (pin) => ({
    key: (c) => c.id,
    compare: (c1, c2) => {
        if (pin) {
            const p1 = c1.pinned ? 1 : 0;
            const p2 = c2.pinned ? 1 : 0;
            if (p1 !== p2) return p2 - p1;
        }
        const a1 = c1.archived ? 0 : 1;
        const a2 = c2.archived ? 0 : 1;
        if (a1 !== a2) return a2 - a1;
        const t1 = c1.conversationTimestamp ? Number(c1.conversationTimestamp) : 0;
        const t2 = c2.conversationTimestamp ? Number(c2.conversationTimestamp) : 0;
        if (t1 !== t2) return t2 - t1;
        return (c2.id || "").localeCompare(c1.id || "");
    }
});

export const waMessageID = (m) => m.key.id || "";

// BUG FIX, same root cause as waChatKey above: `compare` used to receive
// the two entries' composite `key(...)` STRING outputs (via keyed-db.js's
// old buggy insert()), which is why plain string `.localeCompare` worked
// there previously — but only by coincidence, since `key` here (unlike
// chats') already IS the plain lookup id, not a separate sort-priority
// encoding. Updated to a proper entry-to-entry comparator (computing the
// same composite key from each full entry) so it keeps working correctly
// now that keyed-db.js's insert() passes full entries instead of
// pre-computed key strings.
export const waLabelAssociationKey = {
    key: (la) =>
        la.type === LabelAssociationType.Chat
            ? la.chatId + la.labelId
            : la.chatId + la.messageId + la.labelId,
    compare: (a, b) => waLabelAssociationKey.key(b).localeCompare(waLabelAssociationKey.key(a))
};

const makeMessagesDictionary = () => makeOrderedDictionary(waMessageID);

export default function makeInMemoryStore(config) {
    const socket = config.socket;
    const chatKey = config.chatKey || waChatKey(true);
    const labelAssociationKey = config.labelAssociationKey || waLabelAssociationKey;
    const logger =
        config.logger ||
        Defaults_1.DEFAULT_CONNECTION_CONFIG.logger.child({
            stream: "in-mem-store"
        });

    const chats = new KeyedDB(chatKey.compare, chatKey.key);
    const messages = {};
    const contacts = {};
    const groupMetadata = {};
    const presences = {};
    const state = { connection: "close" };
    const labels = new ObjectRepository();
    const labelAssociations = new KeyedDB(labelAssociationKey.compare, labelAssociationKey.key);

    const assertMessageList = (jid) => {
        if (!messages[jid]) messages[jid] = makeMessagesDictionary();
        return messages[jid];
    };

    const contactsUpsert = (newContacts) => {
        const oldContacts = new Set(Object.keys(contacts));
        for (const contact of newContacts) {
            oldContacts.delete(contact.id);
            contacts[contact.id] = { ...(contacts[contact.id] || {}), ...contact };
        }
        return oldContacts;
    };

    const labelsUpsert = (newLabels) => {
        for (const label of newLabels) labels.upsertById(label.id, label);
    };

    const bind = (ev) => {
        ev.on("connection.update", (update) => Object.assign(state, update));

        ev.on("messaging-history.set", ({ chats: newChats, contacts: newContacts, messages: newMessages, isLatest, syncType }) => {
            if (syncType === WAProto_1.proto.HistorySync.HistorySyncType.ON_DEMAND) return;
            if (isLatest) {
                chats.clear();
                for (const id in messages) delete messages[id];
            }
            chats.insertIfAbsent(...newChats);
            const oldContacts = contactsUpsert(newContacts);
            if (isLatest) for (const jid of oldContacts) delete contacts[jid];
            for (const msg of newMessages) {
                const jid = msg.key.remoteJid;
                const list = assertMessageList(jid);
                list.upsert(msg, "prepend");
            }
        });

        ev.on("contacts.upsert", contactsUpsert);

        ev.on("contacts.update", async (updates) => {
            for (const update of updates) {
                const contact = contacts[update.id];
                if (contact) Object.assign(contact, update);
            }
        });

        ev.on("chats.upsert", (newChats) => chats.upsert(...newChats));

        ev.on("chats.update", (updates) => {
            for (let update of updates) {
                chats.update(update.id, (chat) => Object.assign(chat, update));
            }
        });

        ev.on("labels.edit", (label) => {
            if (label.deleted) return labels.deleteById(label.id);
            if (labels.count() < 20) labels.upsertById(label.id, label);
        });

        ev.on("labels.association", ({ type, association }) => {
            if (type === "add") labelAssociations.upsert(association);
            // BUG FIX: was `labelAssociations.delete(association)` — KeyedDB
            // has no `.delete()` method (only `.deleteById(id)`), so this
            // threw `TypeError: labelAssociations.delete is not a function`
            // every time a label association was actually removed.
            if (type === "remove") labelAssociations.deleteById(labelAssociationKey.key(association));
        });

        ev.on("presence.update", ({ id, presences: update }) => {
            presences[id] = presences[id] || {};
            Object.assign(presences[id], update);
        });

        ev.on("chats.delete", (deletions) => {
            for (const item of deletions) chats.deleteById(item);
        });

        ev.on("messages.upsert", ({ messages: newMessages, type }) => {
            if (type !== "append" && type !== "notify") return;
            for (const msg of newMessages) {
                const jid = WABinary_1.jidNormalizedUser(msg.key.remoteJid);
                const list = assertMessageList(jid);
                list.upsert(msg, "append");
                if (type === "notify" && !chats.get(jid))
                    ev.emit("chats.upsert", [
                        {
                            id: jid,
                            conversationTimestamp: Utils_1.toNumber(msg.messageTimestamp),
                            unreadCount: 1
                        }
                    ]);
            }
        });

        ev.on("messages.update", (updates) => {
            for (const { update, key } of updates) {
                const list = assertMessageList(WABinary_1.jidNormalizedUser(key.remoteJid));
                list.updateAssign(key.id, update);
            }
        });

        ev.on("messages.delete", (item) => {
            if ("all" in item) messages[item.jid]?.clear();
            else {
                const jid = item.keys[0].remoteJid;
                const list = messages[jid];
                if (list) {
                    const idSet = new Set(item.keys.map((k) => k.id));
                    list.filter((m) => !idSet.has(m.key.id));
                }
            }
        });
    };

    const toJSON = () => ({
        chats,
        contacts,
        messages,
        labels,
        labelAssociations
    });

    const fromJSON = (json) => {
        chats.upsert(...json.chats);
        labelAssociations.upsert(...(json.labelAssociations || []));
        contactsUpsert(Object.values(json.contacts));
        labelsUpsert(Object.values(json.labels || {}));
        for (const jid in json.messages) {
            const list = assertMessageList(jid);
            for (const msg of json.messages[jid])
                list.upsert(WAProto_1.proto.WebMessageInfo.fromObject(msg), "append");
        }
    };
    const loadMessage = async (jid, id) => {
        return messages[jid]?.get(id)
    }
    // Added from @vansnowi/baileys@1.5.9 — the two persistence entry points
    // that were missing here even though toJSON()/fromJSON() (this fork's
    // own, more careful versions — see fromJSON above, which reconstructs
    // proper WebMessageInfo instances instead of leaving raw parsed JSON)
    // already existed. Uses this fork's own shared BufferJSON.replacer/
    // reviver (Utils/generics.js, already used by make-cache-manager-store.js)
    // rather than duplicating a private copy, so Buffers inside the store
    // (media keys, etc.) survive a save/load round-trip intact.
    const writeToFile = (path) => {
        const data = JSON.stringify(toJSON(), Utils_1.BufferJSON.replacer);
        writeFileSync(path, data);
    };
    const readFromFile = (path) => {
        if (existsSync(path)) {
            logger?.debug?.({ path }, "reading store from file");
            const jsonStr = readFileSync(path, { encoding: "utf-8" });
            const json = JSON.parse(jsonStr, Utils_1.BufferJSON.reviver);
            fromJSON(json);
        }
    };
    return {
        chats,
        contacts,
        messages,
        groupMetadata,
        state,
        presences,
        labels,
        labelAssociations,
        bind,
        toJSON,
        fromJSON,
        writeToFile,
        readFromFile,
        loadMessage
    };
}