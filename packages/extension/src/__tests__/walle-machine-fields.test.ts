import { describe, it, expect } from "vitest";
import { buildWalleMachineFields } from "../walle-machine-fields.js";

describe("buildWalleMachineFields", () => {
  it("returns empty when WALLE_MACHINE_ID is unset (upstream / single-machine)", () => {
    expect(buildWalleMachineFields({})).toEqual({});
  });

  it("returns empty when WALLE_MACHINE_ID is whitespace-only", () => {
    expect(buildWalleMachineFields({ WALLE_MACHINE_ID: "   " })).toEqual({});
  });

  it("emits id alone when only WALLE_MACHINE_ID is set", () => {
    expect(buildWalleMachineFields({ WALLE_MACHINE_ID: "arch-personal" })).toEqual({
      machineId: "arch-personal",
    });
  });

  it("emits id + label + accent when all three are set", () => {
    expect(
      buildWalleMachineFields({
        WALLE_MACHINE_ID: "arch-personal",
        WALLE_MACHINE_LABEL: "Arch (this laptop)",
        WALLE_MACHINE_ACCENT: "#f0a868",
      }),
    ).toEqual({
      machineId: "arch-personal",
      machineLabel: "Arch (this laptop)",
      machineAccent: "#f0a868",
    });
  });

  it("trims surrounding whitespace from each field", () => {
    expect(
      buildWalleMachineFields({
        WALLE_MACHINE_ID: "  arch-personal  ",
        WALLE_MACHINE_LABEL: "  Arch  ",
        WALLE_MACHINE_ACCENT: "  #f0a868  ",
      }),
    ).toEqual({
      machineId: "arch-personal",
      machineLabel: "Arch",
      machineAccent: "#f0a868",
    });
  });

  it("drops empty label/accent but keeps id", () => {
    expect(
      buildWalleMachineFields({
        WALLE_MACHINE_ID: "arch-personal",
        WALLE_MACHINE_LABEL: "",
        WALLE_MACHINE_ACCENT: "   ",
      }),
    ).toEqual({ machineId: "arch-personal" });
  });
});
