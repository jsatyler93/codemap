import { DebugProbe, ProbeResult } from "./debugProbeTypes";

export class ProbeResultStore {
  private readonly probesByNodeId = new Map<string, DebugProbe[]>();
  private readonly resultsByProbeId = new Map<string, ProbeResult>();
  private readonly hitCountByProbeId = new Map<string, number>();

  setProbes(nodeId: string, probes: DebugProbe[]): void {
    this.probesByNodeId.set(nodeId, probes);
    for (const probe of probes) {
      if (!this.hitCountByProbeId.has(probe.id)) {
        this.hitCountByProbeId.set(probe.id, 0);
      }
    }
  }

  getProbes(nodeId: string): DebugProbe[] {
    return this.probesByNodeId.get(nodeId) || [];
  }

  getProbe(probeId: string): DebugProbe | undefined {
    for (const probes of this.probesByNodeId.values()) {
      const match = probes.find((probe) => probe.id === probeId);
      if (match) return match;
    }
    return undefined;
  }

  getAllProbes(): DebugProbe[] {
    return [...this.probesByNodeId.values()].flat();
  }

  clearNode(nodeId: string): void {
    const probes = this.probesByNodeId.get(nodeId) || [];
    for (const probe of probes) {
      this.resultsByProbeId.delete(probe.id);
      this.hitCountByProbeId.delete(probe.id);
    }
    this.probesByNodeId.delete(nodeId);
  }

  nextHitCount(probeId: string): number {
    const next = (this.hitCountByProbeId.get(probeId) || 0) + 1;
    this.hitCountByProbeId.set(probeId, next);
    return next;
  }

  recordResult(result: ProbeResult): void {
    this.resultsByProbeId.set(result.probeId, result);
  }

  getResult(probeId: string): ProbeResult | undefined {
    return this.resultsByProbeId.get(probeId);
  }
}