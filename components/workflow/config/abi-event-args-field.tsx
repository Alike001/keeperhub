"use client";

import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionConfigFieldBase } from "@/plugins/registry";

type AbiEventInput = {
  name?: string;
  type?: string;
  indexed?: boolean;
};

type EventParam = {
  name: string;
  type: string;
  /** False for an indexed array or tuple, which no topic can match on. */
  filterable: boolean;
  /** True for indexed string and bytes, stored as a hash of the value. */
  hashed: boolean;
};

type AbiEventArgsFieldProps = {
  field: ActionConfigFieldBase;
  abiValue: string;
  eventValue: string;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
};

function parseIndexedParams(abiValue: string, eventName: string): EventParam[] {
  if (!(abiValue && eventName)) {
    return [];
  }
  let abi: unknown;
  try {
    abi = JSON.parse(abiValue);
  } catch {
    return [];
  }
  if (!Array.isArray(abi)) {
    return [];
  }
  const event = abi.find(
    (item: { type?: string; name?: string }) =>
      item?.type === "event" && item?.name === eventName
  ) as { inputs?: AbiEventInput[] } | undefined;

  return (event?.inputs ?? [])
    .filter((input) => input.indexed)
    .map((input, index) => {
      const type = input.type ?? "";
      return {
        name: input.name || `arg${index}`,
        type,
        filterable: !(type.endsWith("]") || type.startsWith("tuple")),
        hashed: type === "string" || type === "bytes",
      };
    });
}

function parseValue(raw: string): Record<string, string> {
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // A hand-edited value that no longer parses starts over as empty rather
    // than throwing the whole config panel away.
  }
  return {};
}

function placeholderFor(param: EventParam): string {
  if (param.type === "address") {
    return "0x... or {{NodeName.address}}";
  }
  if (param.type === "bool") {
    return "true or false";
  }
  if (param.hashed) {
    return "exact value";
  }
  if (param.type.startsWith("uint") || param.type.startsWith("int")) {
    return "whole number";
  }
  return `${param.type} value`;
}

export function AbiEventArgsField({
  field,
  abiValue,
  eventValue,
  value,
  onChange,
  disabled,
}: AbiEventArgsFieldProps) {
  const params = React.useMemo(
    () => parseIndexedParams(abiValue, eventValue),
    [abiValue, eventValue]
  );
  const current = React.useMemo(() => parseValue(value), [value]);

  const update = (name: string, next: string) => {
    const merged = { ...current };
    if (next.trim() === "") {
      delete merged[name];
    } else {
      merged[name] = next;
    }
    onChange(Object.keys(merged).length === 0 ? "" : JSON.stringify(merged));
  };

  if (!eventValue) {
    return (
      <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
        Select an event to filter its indexed arguments
      </div>
    );
  }

  if (params.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
        {eventValue} has no indexed parameters, so every occurrence is returned
      </div>
    );
  }

  return (
    <div className="space-y-3" key={field.key}>
      {params.map((param) => (
        <div className="space-y-1" key={param.name}>
          <Label
            className="ml-1 font-normal text-xs"
            htmlFor={`${field.key}-${param.name}`}
          >
            {param.name}{" "}
            <span className="text-muted-foreground">{param.type}</span>
          </Label>
          <Input
            disabled={disabled || !param.filterable}
            id={`${field.key}-${param.name}`}
            onChange={(e) => update(param.name, e.target.value)}
            placeholder={
              param.filterable
                ? placeholderFor(param)
                : "Cannot be filtered at the RPC"
            }
            value={current[param.name] ?? ""}
          />
          {!param.filterable && (
            <p className="ml-1 text-muted-foreground text-xs">
              An indexed {param.type} is stored as a hash of its encoded
              contents, so there is no value to match on. Filter it in a later
              node instead.
            </p>
          )}
          {param.filterable && param.hashed && (
            <p className="ml-1 text-muted-foreground text-xs">
              An indexed {param.type} is stored as a hash, so this matches the
              whole value exactly. Partial matches are not possible, and the
              value cannot be read back from the log.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
