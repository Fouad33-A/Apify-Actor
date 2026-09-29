import { describe, expect, it } from "vitest";

import { BudgetTracker } from "../src/budget.js";

describe("BudgetTracker", () => {
  it("counts each record type and the total", () => {
    const b = new BudgetTracker(10);
    b.record("profile");
    b.record("post");
    b.record("post");
    b.record("comment");
    expect(b.counts).toEqual({ profiles: 1, posts: 2, comments: 1, total: 4 });
    expect(b.stoppedOnCap).toBe(false);
    expect(b.canWriteMore()).toBe(true);
  });

  it("accepts exactly maxItemsPerRun items, then refuses", () => {
    const b = new BudgetTracker(2);
    expect(b.record("post")).toBe(true);
    expect(b.record("post")).toBe(true);
    expect(b.canWriteMore()).toBe(false);
    expect(b.record("post")).toBe(false);
    expect(b.counts.total).toBe(2);
  });

  it("flags stoppedOnCap as soon as the cap is reached, not only on the next refused write", () => {
    const b = new BudgetTracker(1);
    b.record("profile");
    expect(b.stoppedOnCap).toBe(true);
  });

  it("does not count a refused write toward any bucket", () => {
    const b = new BudgetTracker(1);
    b.record("profile");
    b.record("comment");
    expect(b.counts).toEqual({ profiles: 1, posts: 0, comments: 0, total: 1 });
  });

  it("a cap of 0 refuses everything", () => {
    const b = new BudgetTracker(0);
    expect(b.canWriteMore()).toBe(false);
    expect(b.record("profile")).toBe(false);
    expect(b.summary()).toEqual({ maxItemsPerRun: 0, itemsWritten: 0, stoppedOnCap: true });
  });

  it("summary reports the cap, items written and whether it stopped on the cap", () => {
    const b = new BudgetTracker(5);
    b.record("post");
    expect(b.summary()).toEqual({ maxItemsPerRun: 5, itemsWritten: 1, stoppedOnCap: false });
  });
});
