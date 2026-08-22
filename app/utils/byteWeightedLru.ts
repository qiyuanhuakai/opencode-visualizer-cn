export type ByteWeight<K, V> = (key: K, value: V) => number;

export interface ByteWeightedLruOptions<K, V> {
  maxBytes: number;
  maxEntries?: number;
  maxEntryBytes?: number;
  weigh: ByteWeight<K, V>;
}

type WeightedEntry<V> = {
  value: V;
  bytes: number;
};

export class ByteWeightedLruCache<K, V> {
  private readonly entriesByKey = new Map<K, WeightedEntry<V>>();

  private currentBytes = 0;

  private readonly maxBytes: number;

  private readonly maxEntries: number | undefined;

  private readonly maxEntryBytes: number | undefined;

  private readonly weigh: ByteWeight<K, V>;

  public constructor(options: ByteWeightedLruOptions<K, V>) {
    if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0) {
      throw new RangeError('maxBytes must be a finite number greater than zero');
    }
    if (
      options.maxEntries !== undefined &&
      (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0)
    ) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    if (
      options.maxEntryBytes !== undefined &&
      (!Number.isFinite(options.maxEntryBytes) || options.maxEntryBytes <= 0)
    ) {
      throw new RangeError('maxEntryBytes must be a finite number greater than zero');
    }
    this.maxBytes = options.maxBytes;
    this.maxEntries = options.maxEntries;
    this.maxEntryBytes = options.maxEntryBytes;
    this.weigh = options.weigh;
  }

  public get size(): number {
    return this.entriesByKey.size;
  }

  public get bytes(): number {
    return this.currentBytes;
  }

  public has(key: K): boolean {
    return this.entriesByKey.has(key);
  }

  public get(key: K): V | undefined {
    const entry = this.entriesByKey.get(key);
    if (!entry) return undefined;
    this.entriesByKey.delete(key);
    this.entriesByKey.set(key, entry);
    return entry.value;
  }

  public set(key: K, value: V): this {
    const bytes = this.entryWeight(key, value);
    this.delete(key);
    if (!this.canStore(bytes)) return this;
    this.evictUntilFits(bytes);

    this.entriesByKey.set(key, { value, bytes });
    this.currentBytes += bytes;
    return this;
  }

  public delete(key: K): boolean {
    const entry = this.entriesByKey.get(key);
    if (!entry) return false;
    this.entriesByKey.delete(key);
    this.currentBytes -= entry.bytes;
    return true;
  }

  public clear(): void {
    this.entriesByKey.clear();
    this.currentBytes = 0;
  }

  public entries(): IterableIterator<[K, V]> {
    return this.valuesWithKeys();
  }

  private *valuesWithKeys(): IterableIterator<[K, V]> {
    for (const [key, entry] of this.entriesByKey) {
      yield [key, entry.value];
    }
  }

  private entryWeight(key: K, value: V): number {
    const bytes = this.weigh(key, value);
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError('entry weight must be a finite number greater than or equal to zero');
    }
    return bytes;
  }

  private canStore(bytes: number): boolean {
    return bytes <= this.maxBytes && (this.maxEntryBytes === undefined || bytes <= this.maxEntryBytes);
  }

  private evictUntilFits(bytes: number): void {
    while (this.exceedsBudget(bytes)) {
      const oldest = this.entriesByKey.keys().next();
      if (oldest.done) return;
      this.delete(oldest.value);
    }
  }

  private exceedsBudget(bytes: number): boolean {
    const exceedsBytes = this.currentBytes + bytes > this.maxBytes;
    const exceedsEntries =
      this.maxEntries !== undefined && this.entriesByKey.size >= this.maxEntries;
    return exceedsBytes || exceedsEntries;
  }
}
