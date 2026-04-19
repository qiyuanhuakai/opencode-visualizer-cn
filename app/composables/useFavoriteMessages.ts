import { ref, watch } from 'vue';
import { StorageKeys, storageGet, storageKey, storageSetJSON } from '../utils/storageKeys';

export type FavoriteMessageEntry = {
  text: string;
  agent?: string;
  agentColor?: string;
  model?: string;
  variant?: string;
  isSubagent?: boolean;
};

function toFavoriteMessageEntry(value: unknown): FavoriteMessageEntry | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string') return null;
  const entry: FavoriteMessageEntry = {
    text: record.text,
  };
  if (typeof record.agent === 'string') entry.agent = record.agent;
  if (typeof record.agentColor === 'string') entry.agentColor = record.agentColor;
  if (typeof record.model === 'string') entry.model = record.model;
  if (typeof record.variant === 'string') entry.variant = record.variant;
  if (record.isSubagent === true) entry.isSubagent = true;
  return entry;
}

function parseFavoriteMessages(raw: string | null): FavoriteMessageEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => toFavoriteMessageEntry(item))
      .filter((item): item is FavoriteMessageEntry => Boolean(item));
  } catch {
    return [];
  }
}

function isSameFavoriteMessages(a: FavoriteMessageEntry[], b: FavoriteMessageEntry[]) {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const next = b[index];
    return (
      next &&
      item.text === next.text &&
        (item.agent ?? '') === (next.agent ?? '') &&
        (item.agentColor ?? '') === (next.agentColor ?? '') &&
        (item.model ?? '') === (next.model ?? '') &&
        (item.variant ?? '') === (next.variant ?? '') &&
        Boolean(item.isSubagent) === Boolean(next.isSubagent)
    );
  });
}

const favorites = ref<FavoriteMessageEntry[]>(
  parseFavoriteMessages(storageGet(StorageKeys.favorites.messages)),
);

watch(
  favorites,
  (value) => {
    storageSetJSON(StorageKeys.favorites.messages, value);
  },
);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey(StorageKeys.favorites.messages)) return;
    const nextFavorites = parseFavoriteMessages(event.newValue);
    if (isSameFavoriteMessages(favorites.value, nextFavorites)) return;
    favorites.value = nextFavorites;
  });
}

function normalizeText(text: string) {
  return text.trim();
}

export function useFavoriteMessages() {
  function isFavorite(entry: { text: string; agent?: string; model?: string; variant?: string; isSubagent?: boolean }) {
    const normalized = normalizeText(entry.text);
    if (!normalized) return false;
    return favorites.value.some(
      (fav) =>
        normalizeText(fav.text) === normalized &&
        (fav.agent ?? '') === (entry.agent ?? '') &&
        (fav.model ?? '') === (entry.model ?? '') &&
        (fav.variant ?? '') === (entry.variant ?? '') &&
        Boolean(fav.isSubagent) === Boolean(entry.isSubagent),
    );
  }

  function addFavorite(entry: FavoriteMessageEntry) {
    const normalized = normalizeText(entry.text);
    if (!normalized) return;
    if (isFavorite({ ...entry, text: normalized })) return;
    favorites.value = [...favorites.value, { ...entry, text: normalized }];
  }

  function removeFavorite(index: number) {
    if (index < 0 || index >= favorites.value.length) return;
    favorites.value = favorites.value.filter((_, currentIndex) => currentIndex !== index);
  }

  return {
    favorites,
    isFavorite,
    addFavorite,
    removeFavorite,
  };
}
