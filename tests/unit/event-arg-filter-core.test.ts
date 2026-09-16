import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import {
  buildEventArgTopics,
  indexedParams,
} from "@/plugins/web3/steps/event-arg-filter-core";

const TRANSFER = ethers.EventFragment.from(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);
const MIXED = ethers.EventFragment.from(
  "event Mixed(int256 indexed delta, string indexed label, bool indexed flag)"
);
const WITH_ARRAY = ethers.EventFragment.from(
  "event Batched(uint256[] indexed ids, address indexed who)"
);
const UNINDEXED_ONLY = ethers.EventFragment.from("event Plain(uint256 amount)");

const ALICE = "0x51C72848c68a965f66FA7a88855F9f7784502a7F";

function ok(raw: string | undefined, fragment: ethers.EventFragment) {
  const result = buildEventArgTopics(raw, fragment);
  if (!result.success) {
    throw new Error(`expected success, got: ${result.error}`);
  }
  return result;
}

function err(raw: string, fragment: ethers.EventFragment): string {
  const result = buildEventArgTopics(raw, fragment);
  if (result.success) {
    throw new Error("expected a validation error");
  }
  return result.error;
}

describe("buildEventArgTopics", () => {
  it("returns no topic filter when nothing is being filtered", () => {
    for (const raw of [undefined, "", "   ", "{}", '{"from":""}']) {
      expect(ok(raw, TRANSFER).topics, String(raw)).toBeNull();
    }
  });

  it("builds the event signature plus one topic per filtered argument", () => {
    const { topics, applied } = ok(`{"from":"${ALICE}"}`, TRANSFER);
    expect(topics).toEqual([
      TRANSFER.topicHash,
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ALICE]),
    ]);
    expect(applied).toEqual(["from"]);
  });

  it("keeps a wildcard for an earlier argument that was left empty", () => {
    // Filtering only the second indexed parameter still has to put a null in
    // the first slot, or the value would be matched against the wrong topic.
    const { topics } = ok(`{"to":"${ALICE}"}`, TRANSFER);
    expect(topics).toEqual([
      TRANSFER.topicHash,
      null,
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ALICE]),
    ]);
  });

  it("drops trailing wildcards, which say nothing", () => {
    const { topics } = ok(`{"delta":"1"}`, MIXED);
    expect(topics).toHaveLength(2);
  });

  it("encodes a negative signed value as two's complement", () => {
    // ethers' own contract.filters helper refuses this outright with
    // "unsigned value cannot be negative", which is why topics are built
    // here rather than through it.
    const { topics } = ok(`{"delta":"-5"}`, MIXED);
    expect(topics?.[1]).toBe(
      ethers.AbiCoder.defaultAbiCoder().encode(["int256"], [-5])
    );
    expect(topics?.[1]).toBe(`0x${"f".repeat(63)}b`);
  });

  it("hashes an indexed string, matching the whole value exactly", () => {
    const { topics } = ok(`{"label":"hello"}`, MIXED);
    expect(topics?.[2]).toBe(ethers.keccak256(ethers.toUtf8Bytes("hello")));
  });

  it("accepts a boolean written as text", () => {
    const { topics } = ok(`{"flag":"true"}`, MIXED);
    expect(topics?.[3]).toBe(
      ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true])
    );
  });

  it("rejects a parameter that exists but is not indexed", () => {
    expect(err(`{"value":"1"}`, TRANSFER)).toContain(
      "'value' is not an indexed parameter"
    );
  });

  it("rejects a parameter the event does not have, and names the ones it does", () => {
    const message = err(`{"sender":"1"}`, TRANSFER);
    expect(message).toContain("'sender' is not a parameter");
    expect(message).toContain("from, to");
  });

  it("rejects an indexed array, which no topic can match", () => {
    // The topic for an indexed array is a hash of the encoded contents, so
    // there is no value to compare against. ethers throws "filtering with
    // tuples or arrays not supported" at call time; this fails first, in
    // validation, naming the parameter.
    expect(err(`{"ids":"1"}`, WITH_ARRAY)).toContain("indexed uint256[]");
    expect(indexedParams(WITH_ARRAY)).toEqual([
      { name: "ids", type: "uint256[]", filterable: false },
      { name: "who", type: "address", filterable: true },
    ]);
  });

  it("rejects a negative value for an unsigned parameter", () => {
    expect(err(`{"from":"-1"}`, TRANSFER)).toContain("must be");
  });

  it("rejects a malformed address rather than querying for nothing", () => {
    expect(err(`{"from":"0x1234"}`, TRANSFER)).toContain("20-byte address");
  });

  it("rejects a filter on an event with no indexed parameters", () => {
    expect(err(`{"amount":"1"}`, UNINDEXED_ONLY)).toContain("none");
  });

  it("rejects input that is not a JSON object of single values", () => {
    expect(err("not json", TRANSFER)).toContain("not valid JSON");
    expect(err('["0x00"]', TRANSFER)).toContain("JSON object");
    expect(err('{"from":{"a":1}}', TRANSFER)).toContain("single value");
  });
});
