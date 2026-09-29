"use client";

import { useEffect, useRef } from "react";

type SidebarField = { key: string; label: string; group: string; value: string | null };

export function VerifySidebarFields({ fields }: { fields: SidebarField[] }) {
  const refs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    const cleanups = fields.map(({ key }) => {
      const original = document.getElementById(`vf-${key}`) as HTMLInputElement | null;
      if (!original) return () => {};
      const sync = () => {
        const sidebar = refs.current[key];
        if (sidebar && sidebar.value !== original.value) sidebar.value = original.value;
      };
      original.addEventListener("input", sync);
      return () => original.removeEventListener("input", sync);
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [fields]);

  return (
    <div className="vattention-links">
      {fields.map((field) => (
        <div className="vattention-item" key={field.key}>
          <div className="vattention-item-head">
            <a href={`#field-${field.key}`} title="Jump to this field in the deal sheet">{field.label}</a>
            <small>{field.group === "Money" ? "Financial" : field.group}</small>
          </div>
          <input
            id={`attention-${field.key}`}
            aria-label={`${field.label}, ${field.group === "Money" ? "Financial" : field.group}`}
            ref={(node) => { refs.current[field.key] = node; }}
            type="text"
            defaultValue={field.value ?? ""}
            autoComplete="off"
            inputMode={field.key === "fuel.type" ? "text" : "numeric"}
            onInput={(event) => {
              const original = document.getElementById(`vf-${field.key}`) as HTMLInputElement | null;
              if (original) original.value = event.currentTarget.value;
            }}
          />
        </div>
      ))}
    </div>
  );
}
