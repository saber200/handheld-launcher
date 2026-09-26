import { useCallback, useEffect, useState } from "react";

export type CardGroup = { id: string; name: string };

type Bucket = {
  groups: CardGroup[];
  membership: Record<string, string>;
  names: Record<string, string>;
};

function emptyBucket(): Bucket {
  return { groups: [], membership: {}, names: {} };
}

function storageKey(kind: "games" | "apps") {
  return `handheld-launcher.groups.${kind}`;
}

function load(kind: "games" | "apps"): Bucket {
  try {
    const own = localStorage.getItem(storageKey(kind));
    if (own) return { ...emptyBucket(), ...(JSON.parse(own) as Bucket) };
    const legacy = localStorage.getItem("handheld-launcher.groups.v1");
    if (!legacy) return emptyBucket();
    const parsed = JSON.parse(legacy) as Partial<Record<"games" | "apps", Bucket>>;
    return { ...emptyBucket(), ...(parsed[kind] ?? {}) };
  } catch {
    return emptyBucket();
  }
}

export function useLibraryGroups(kind: "games" | "apps") {
  const [bucket, setBucket] = useState<Bucket>(() => load(kind));
  const [activeId, setActiveId] = useState("all");

  useEffect(() => {
    localStorage.setItem(storageKey(kind), JSON.stringify(bucket));
  }, [bucket, kind]);

  const filters = ["all", ...bucket.groups.map((group) => group.id)];

  const cycle = useCallback(
    (dir: -1 | 1) => {
      setActiveId((current) => {
        const index = Math.max(0, filters.indexOf(current));
        return filters[(index + dir + filters.length) % filters.length];
      });
    },
    [filters],
  );

  const createGroup = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const existing = bucket.groups.find((group) => group.name === trimmed);
    if (existing) {
      setActiveId(existing.id);
      return existing.id;
    }
    const id = `${kind}-${Date.now()}`;
    setBucket((prev) => ({
      ...prev,
      groups: [...prev.groups, { id, name: trimmed }],
    }));
    setActiveId(id);
    return id;
  }, [bucket.groups, kind]);

  const assignCard = useCallback((cardId: string, groupId: string | null) => {
    setBucket((prev) => {
      const membership = { ...prev.membership };
      if (groupId) membership[cardId] = groupId;
      else delete membership[cardId];
      return { ...prev, membership };
    });
  }, []);

  const setName = useCallback((cardId: string, name: string | null) => {
    setBucket((prev) => {
      const names = { ...prev.names };
      if (name) names[cardId] = name;
      else delete names[cardId];
      return { ...prev, names };
    });
  }, []);

  return {
    groups: bucket.groups,
    membership: bucket.membership,
    names: bucket.names ?? {},
    activeId,
    cycle,
    createGroup,
    assignCard,
    setName,
  };
}
