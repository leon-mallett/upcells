import { z } from "zod";

export const connectionSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  instance_url: z
    .string()
    .url("Must be a valid URL")
    .refine(
      (v) =>
        v.includes(".salesforce.com") ||
        v.includes(".force.com") ||
        v.startsWith("https://"),
      "Must be a Salesforce instance URL (e.g. https://myorg.my.salesforce.com)"
    ),
  client_id: z
    .string()
    .min(10, "Consumer Key appears too short")
    .max(500, "Consumer Key appears too long"),
});

export type ConnectionFormValues = z.infer<typeof connectionSchema>;

export const licenseKeySchema = z.object({
  license_key: z
    .string()
    .min(10, "License key appears too short")
    .regex(
      /^[A-Z0-9]{4,6}(-[A-Z0-9]{4,6}){3,7}$/i,
      "License key format should be XXXX-XXXX-XXXX-XXXX"
    ),
});

export type LicenseKeyFormValues = z.infer<typeof licenseKeySchema>;
