export interface ImpactRange {
  min: number;
  max: number;
}

/**
 * Estimated environmental impacts of one model call (EcoLogits). Energy in kWh,
 * gwp in kgCO2eq, adpe in kgSbeq, pe in MJ, wcf in litres. `unmapped` marks a
 * call whose model has no estimate.
 */
export interface TransactionImpacts {
  energy?: ImpactRange;
  gwp?: ImpactRange;
  adpe?: ImpactRange;
  pe?: ImpactRange;
  wcf?: ImpactRange;
  warnings?: string[];
  unmapped?: boolean;
}

/** Sums of the estimates over a set of transactions */
export interface ImpactsTotals {
  energy: ImpactRange;
  gwp: ImpactRange;
  /** True when at least one model call in the set has no estimate */
  partial: boolean;
}

export interface TransactionData {
  user: string;
  conversationId: string;
  tokenType: string;
  model?: string;
  context?: string;
  valueKey?: string;
  rate?: number;
  rawAmount?: number;
  tokenValue?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  messageId?: string;
  inputTokenCount?: number;
  rateDetail?: Record<string, number>;
  impacts?: TransactionImpacts;
}
