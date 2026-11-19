// @vitest-environment happy-dom
import { afterEach, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PayoutEditor } from "../src/economics";
import type { PageEconomics } from "@wika/core";
afterEach(cleanup);
const state: PageEconomics = {
  active: true,
  legacy: false,
  lockedAt: null,
  price: "1000000000000",
  policyHash: "0x" + "ab".repeat(32),
  policy: {
    ruleset: 1,
    revision: "0",
    model: 1,
    ownerBps: 4500,
    supporterBps: 4500,
    referralBps: 900,
    protocolBps: 100,
    rounds: 4,
    treasury: "treasury",
    configurator: null,
    ownerPeriod: null,
  },
  rules: {
    version: 1,
    ownerMin: 0,
    ownerMax: 9800,
    supporterMin: 100,
    supporterMax: 9800,
    referralMin: 100,
    referralMax: 9800,
    protocolBps: 100,
    minimumPrice: "100",
    treasury: "treasury",
  },
};
it("requires race consent and explicit balanced custom selection without changing other fields", async () => {
  const user = userEvent.setup(),
    selected = vi.fn();
  render(<PayoutEditor state={state} forClaim onSelect={selected} />);
  const button = screen.getByRole("button", {
    name: "Use this split for review",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await user.selectOptions(screen.getByLabelText("Selection"), "custom");
  const a = screen.getByLabelText("Owner (%)"),
    s = screen.getByLabelText("Supporters (%)"),
    r = screen.getByLabelText("Referrals (%)");
  await user.clear(a);
  await user.type(a, "25");
  expect((s as HTMLInputElement).value).toBe("45");
  await user.clear(s);
  await user.type(s, "60");
  await user.clear(r);
  await user.type(r, "14");
  await user.click(screen.getByRole("checkbox"));
  await user.click(button);
  expect(selected).toHaveBeenLastCalledWith(
    expect.objectContaining({
      ownerBps: 2500,
      supporterBps: 6000,
      referralBps: 1400,
      inheritIfChanged: true,
    })
  );
  await user.clear(r);
  await user.type(r, "14.001");
  await user.click(button);
  expect(screen.getByRole("alert").textContent).toContain("two decimal");
  expect(selected).toHaveBeenLastCalledWith(null);
});
it("shows inherited locked terms and never offers an edit", () => {
  render(
    <PayoutEditor
      state={{ ...state, legacy: true, lockedAt: "0" }}
      forClaim
      onSelect={vi.fn()}
    />
  );
  expect(
    screen.getByText(/inherited legacy payout policy is fixed/)
  ).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
