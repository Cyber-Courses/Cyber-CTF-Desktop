/** Approximate us-east-1 on-demand Linux $/hour, for showing a cost estimate in the UI. */
export const AWS_INSTANCE_PRICE: Record<string, number> = {
  "t3.small": 0.0208,
  "t3.medium": 0.0416,
  "t3.large": 0.0832,
  "t3.xlarge": 0.1664,
};

/** The approximate hourly price of an instance type, or null if unknown. */
export const awsHourly = (instance?: string | null): number | null =>
  instance ? (AWS_INSTANCE_PRICE[instance] ?? null) : null;
