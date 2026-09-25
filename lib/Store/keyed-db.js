export default class KeyedDB {
    constructor(compareFn, idGetter) {
        if (typeof compareFn !== "function" || typeof idGetter !== "function") {
            throw new Error("KeyedDB requires compare and idGetter functions");
        }
        this._compare = compareFn;
        this._idGetter = idGetter;
        this._array = [];
        this._dict = {};
    }
    get length() {
        return this._array.length;
    }
    get(id) {
        return this._dict[id];
    }
    insert(entry, mode = "insert") {
        const id = this._idGetter(entry);
        const existing = this._dict[id];
        if (existing && mode === "insert") {
            return false;
        }
        this._dict[id] = entry;
        let inserted = false;
        for (let i = 0; i < this._array.length; i++) {
            // BUG FIX (found while adding writeToFile/readFromFile — see
            // make-in-memory-store.js changelog note): this used to compare
            // this._idGetter(this._array[i]) against `id` — i.e. it fed the
            // ID-getter's output into `_compare` on both sides. That only
            // works if idGetter ALSO doubles as a sort-priority key (which
            // it did for the old `waChatKey`, at the cost of breaking
            // `get()`/`update()`/`deleteById()`, since those take a *plain*
            // id, not a composite sort key, and index into `_dict` by
            // whatever `idGetter` actually returns). Comparing the full
            // entries directly instead — matching @vansnowi/baileys@1.5.9's
            // implementation — lets idGetter go back to being just "the
            // plain unique id", with `compare` doing its own real job of
            // ordering two full entries.
            const cmp = this._compare(entry, this._array[i]);
            if (cmp < 0) {
                this._array.splice(i, 0, entry);
                inserted = true;
                break;
            }
        }
        if (!inserted) this._array.push(entry);
        return true;
    }
    insertIfAbsent(...entries) {
        const added = [];
        for (const entry of entries) {
            if (!this._dict[this._idGetter(entry)]) {
                this.insert(entry);
                added.push(entry);
            }
        }
        return added;
    }
    upsert(...entries) {
        const added = [];
        for (const entry of entries) {
            const id = this._idGetter(entry);
            if (this._dict[id]) {
                const idx = this._array.findIndex(e => this._idGetter(e) === id);
                if (idx >= 0) this._array[idx] = entry;
                this._dict[id] = entry;
            } else {
                this.insert(entry);
                added.push(entry);
            }
        }
        return added;
    }
    update(id, updater) {
        const item = this._dict[id];
        if (!item) return false;
        updater(item);
        const idx = this._array.findIndex(e => this._idGetter(e) === id);
        if (idx >= 0) this._array[idx] = item;
        return true;
    }
    updateAssign(id, update) {
        const item = this._dict[id];
        if (!item) return false;
        Object.assign(item, update);
        const idx = this._array.findIndex(e => this._idGetter(e) === id);
        if (idx >= 0) this._array[idx] = item;
        return true;
    }
    deleteById(id) {
        if (!this._dict[id]) return false;
        delete this._dict[id];
        const idx = this._array.findIndex(e => this._idGetter(e) === id);
        if (idx >= 0) this._array.splice(idx, 1);
        return true;
    }
    clear() {
        this._array = [];
        this._dict = {};
    }
    all() {
        return [...this._array];
    }
    filter(predicate) {
        this._array = this._array.filter(predicate);
        this._dict = {};
        for (const entry of this._array) {
            this._dict[this._idGetter(entry)] = entry;
        }
    }
    count() {
        return this._array.length;
    }
    toJSON() {
        return this._array;
    }
    fromJSON(array) {
        this.clear();
        for (const entry of array) this.insert(entry);
    }
}