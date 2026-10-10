"use client";

import { ArrowLeft, Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-pill";
import { Field, Nav, Note, Select, Step } from "@/features/servers/host-setup/form";
import { AccessKeyCredentials, OciCredentials, TokenCredentials } from "@/features/servers/host-setup/credentials-keys";
import { AwsCliCredentials, AzureCredentials, GcpCredentials } from "@/features/servers/host-setup/credentials-cli";
import { REGIONS } from "@/features/servers/host-setup/setup-model";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";
import { useT, type T } from "@/lib/i18n";

/** How the chosen cloud signs in: an OCI config, an API token, the Azure or GCP CLI, the AWS
 *  CLI or AWS access keys; then the region its labs run in. */
export function CredentialsStep({ s }: { s: HostSetup }) {
  const t = useT();
  const { v, error, azure, gcp, oci, tokenCloud, connectionOk, next, back } = s;
  const regions = REGIONS[s.cloudProvider];
  return (
    <Step icon={Cloud} title={stepTitle(s, t)} description={stepDescription(s, t)}>
      {oci ? (
        <OciCredentials s={s} />
      ) : tokenCloud ? (
        <TokenCredentials s={s} />
      ) : azure ? (
        <AzureCredentials s={s} />
      ) : gcp ? (
        <GcpCredentials s={s} />
      ) : v.useCliCreds ? (
        <AwsCliCredentials s={s} />
      ) : (
        <AccessKeyCredentials s={s} />
      )}
      <div className="mt-3">
        <Field label={azure ? t("servers.setup.credentials.location") : t("servers.setup.credentials.region")}>
          <Select value={v.host} onChange={(e) => s.set("host", e.target.value)}>
            {v.host && !regions.some(([code]) => code === v.host) && <option value={v.host}>{v.host}</option>}
            {regions.map(([code, name]) => (
              <option key={code} value={code}>
                {code} · {name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {error && (
        <Note className="mt-3 flex items-start gap-2.5">
          <StatusDot tone="fail" className="mt-1.5" />
          <span className="min-w-0 break-words text-muted-foreground">{error}</span>
        </Note>
      )}
      <Nav
        left={
          <Button variant="ghost" onClick={back}>
            <ArrowLeft className="size-4" /> {t("servers.setup.nav.back")}
          </Button>
        }
        right={
          <Button onClick={next} disabled={!connectionOk}>
            {t("servers.setup.nav.continue")}
          </Button>
        }
      />
    </Step>
  );
}

const tokenCloudName = (s: HostSetup) => (s.digitalocean ? "DigitalOcean" : "Linode");

function stepTitle(s: HostSetup, t: T) {
  if (s.azure) return t("servers.setup.credentials.titles.azure");
  if (s.gcp) return t("servers.setup.credentials.titles.gcp");
  if (s.digitalocean) return t("servers.setup.credentials.titles.digitalocean");
  if (s.linode) return t("servers.setup.credentials.titles.linode");
  if (s.oci) return "Oracle Cloud";
  return s.v.useCliCreds ? "AWS CLI" : t("servers.setup.credentials.titles.accessKeys");
}

function stepDescription(s: HostSetup, t: T) {
  if (s.azure) return t("servers.setup.credentials.descriptions.azure");
  if (s.gcp) return t("servers.setup.credentials.descriptions.gcp");
  if (s.tokenCloud) return t("servers.setup.credentials.descriptions.token", { cloud: tokenCloudName(s) });
  if (s.oci) return t("servers.setup.credentials.descriptions.oci");
  return s.v.useCliCreds ? t("servers.setup.credentials.descriptions.awsCli") : t("servers.setup.credentials.descriptions.accessKeys");
}
