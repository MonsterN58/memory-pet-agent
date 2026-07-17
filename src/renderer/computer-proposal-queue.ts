import type { ComputerActionProposal, ComputerActionResult } from "../common/types";

export interface ComputerProposalTicket {
  revision: number;
  proposalId: string;
}

export type ComputerProposalTransitionKind =
  | "idle"
  | "preserved"
  | "replaced"
  | "next"
  | "finished"
  | "stopped"
  | "stale";

export interface ComputerProposalTransition {
  kind: ComputerProposalTransitionKind;
  active?: ComputerActionProposal;
  ticket?: ComputerProposalTicket;
  cancel: ComputerActionProposal[];
}

/**
 * Pure Renderer queue state. A revision-bound ticket prevents a late result
 * from an older approval card from advancing or clearing a newer work plan.
 */
export class ComputerProposalQueue {
  private proposals: ComputerActionProposal[] = [];
  private revision = 0;
  private executingProposalId?: string;

  acceptResponse(actions: readonly ComputerActionProposal[]): ComputerProposalTransition {
    if (actions.length === 0) return this.snapshot(this.proposals.length ? "preserved" : "idle");

    const next: ComputerActionProposal[] = [];
    const ids = new Set<string>();
    for (const action of actions) {
      if (!action.id || ids.has(action.id)) continue;
      ids.add(action.id);
      next.push(action);
      if (next.length === 4) break;
    }
    if (next.length === 0) return this.snapshot(this.proposals.length ? "preserved" : "idle");

    const cancel = this.proposals.filter((proposal) => proposal.id !== this.executingProposalId);
    this.proposals = next;
    this.executingProposalId = undefined;
    this.revision += 1;
    return this.snapshot("replaced", cancel);
  }

  beginExecution(ticket: ComputerProposalTicket): boolean {
    if (!this.matches(ticket) || this.executingProposalId !== undefined) return false;
    this.executingProposalId = ticket.proposalId;
    return true;
  }

  settle(
    ticket: ComputerProposalTicket,
    status: ComputerActionResult["status"],
  ): ComputerProposalTransition {
    if (!this.matches(ticket) || this.executingProposalId !== ticket.proposalId) {
      return this.snapshot("stale");
    }

    const remaining = this.proposals.slice(1);
    this.executingProposalId = undefined;
    this.revision += 1;
    if (status === "completed" && remaining.length > 0) {
      this.proposals = remaining;
      return this.snapshot("next");
    }

    this.proposals = [];
    return this.snapshot(status === "completed" ? "finished" : "stopped", status === "completed" ? [] : remaining);
  }

  fail(ticket: ComputerProposalTicket): ComputerProposalTransition {
    if (!this.matches(ticket) || this.executingProposalId !== ticket.proposalId) {
      return this.snapshot("stale");
    }
    const cancel = [...this.proposals];
    this.proposals = [];
    this.executingProposalId = undefined;
    this.revision += 1;
    return this.snapshot("stopped", cancel);
  }

  hasPending(): boolean {
    return this.proposals.length > 0;
  }

  private matches(ticket: ComputerProposalTicket): boolean {
    return ticket.revision === this.revision && this.proposals[0]?.id === ticket.proposalId;
  }

  private snapshot(
    kind: ComputerProposalTransitionKind,
    cancel: ComputerActionProposal[] = [],
  ): ComputerProposalTransition {
    const active = this.proposals[0];
    return {
      kind,
      ...(active ? {
        active,
        ticket: { revision: this.revision, proposalId: active.id },
      } : {}),
      cancel,
    };
  }
}
