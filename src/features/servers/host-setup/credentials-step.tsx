"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, CheckCircle2, Cloud, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/ui/log-console";
import { AWS_REGIONS, AZURE_LOCATIONS, DO_REGIONS, GCP_REGIONS, LINODE_REGIONS, OCI_REGIONS } from "@/features/servers/host-setup/constants";
import { Field, Input, Nav, Select, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";

export function CredentialsStep({ s }: { s: HostSetup }) {
  const {
    v,
    error,
    signingIn,
    signInLog,
    editing,
    azure,
    gcp,
    digitalocean,
    linode,
    oci,
    ociCfg,
    tokenCloud,
    profiles,
    awsIdentity,
    checkingId,
    azureSubs,
    azureChecking,
    gcpBilling,
    gcpOrgs,
    gcpEmail,
    gcpChecking,
    awsSignIn,
    set,
    text,
    connectionOk,
    next,
    back,
    signIn,
  } = s;
  return (
    <Step
      icon={Cloud}
      title={
        azure
          ? "Azure subscription"
          : gcp
            ? "Google Cloud project"
            : digitalocean
              ? "DigitalOcean token"
              : linode
                ? "Linode token"
                : oci
                  ? "Oracle Cloud"
                  : v.useCliCreds
                    ? "AWS CLI"
                    : "Access keys"
      }
      description={
        azure
          ? "Sign in with the Azure CLI, then pick your subscription and location."
          : gcp
            ? "Sign in with the gcloud CLI, then pick a billing account. Labs run in one Cyber CTF labs project, created on the first test (it needs one free project slot on the billing account)."
            : tokenCloud
              ? `Paste a ${digitalocean ? "DigitalOcean" : "Linode"} API token with read/write scope, and pick a region.`
              : oci
                ? "Uses ~/.oci/config (API signing key). Pick a compartment and region."
                : v.useCliCreds
                  ? "Pick a profile, or sign in with the browser."
                  : "An IAM user's access keys."
      }
    >
      {oci ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-[0.75rem]">
            {ociCfg?.configured ? (
              <span className="flex items-center gap-1.5 text-emerald-500">
                <CheckCircle2 className="size-3.5" /> Found ~/.oci/config
              </span>
            ) : (
              <span className="text-muted-foreground">No ~/.oci/config found. Set it up with `oci setup config` or from the console.</span>
            )}
            <button
              type="button"
              onClick={() => openUrl("https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm").catch(() => {})}
              className="ml-auto inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
            >
              How to set up <ExternalLink className="size-3" />
            </button>
          </div>
          <Field label="Compartment OCID" hint="the tenancy root OCID works">
            <Input {...text("username")} placeholder="ocid1.compartment.oc1..…" />
          </Field>
        </div>
      ) : tokenCloud ? (
        <div className="space-y-3">
          <Field label="API token" hint="read/write scope">
            <Input
              type="password"
              value={v.password ?? ""}
              onChange={(e) => set("password", e.target.value || null)}
              placeholder={editing ? "Unchanged" : digitalocean ? "dop_v1_…" : "…"}
              autoComplete="off"
            />
          </Field>
          <p className="text-[0.6875rem] text-muted-foreground">
            No token?{" "}
            <button
              type="button"
              onClick={() =>
                openUrl(digitalocean ? "https://cloud.digitalocean.com/account/api/tokens" : "https://cloud.linode.com/profile/tokens").catch(() => {})
              }
              className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
            >
              Create one in the {digitalocean ? "DigitalOcean" : "Linode"} console <ExternalLink className="size-3" />
            </button>
          </p>
        </div>
      ) : azure ? (
        <div className="space-y-3">
          {azureChecking ? (
            <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-[0.75rem] text-muted-foreground">
              <Spinner className="size-3.5" /> Checking the Azure CLI…
            </div>
          ) : azureSubs.length > 0 ? (
            <>
              {/* The sign-in, its log, then the subscription it gives access to (as for GCP). */}
              <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[0.75rem]">
                <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                <span className="text-muted-foreground">Signed in to the Azure CLI.</span>
                <button
                  type="button"
                  onClick={signIn}
                  disabled={signingIn}
                  className="ml-auto shrink-0 text-[0.6875rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                >
                  {signingIn ? "Signing in…" : "Switch account"}
                </button>
              </div>
              {signInLog && <LogConsole lines={signInLog} running={signingIn} title="Sign in" collapseOnDone />}
              <Field label="Subscription">
                <Select value={v.username} onChange={(e) => set("username", e.target.value)}>
                  {!v.username && <option value="">Choose a subscription…</option>}
                  {azureSubs.map((sub) => (
                    <option key={sub.id} value={sub.id}>
                      {sub.name}
                      {sub.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-[0.75rem]">
                <span className="text-muted-foreground">Sign in with the Azure CLI to list your subscriptions.</span>
                <Button variant="outline" size="sm" className="ml-auto" onClick={signIn} disabled={signingIn}>
                  {signingIn ? <Spinner className="size-3.5" /> : null} Sign in (az login)
                </Button>
              </div>
              {signInLog && <LogConsole lines={signInLog} running={signingIn} title="Sign in" collapseOnDone />}
              <Field label="Subscription ID" hint="or paste it">
                <Input {...text("username")} placeholder="00000000-0000-0000-0000-000000000000" />
              </Field>
            </>
          )}
        </div>
      ) : gcp ? (
        <div className="space-y-3">
          {gcpChecking ? (
            <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-[0.75rem] text-muted-foreground">
              <Spinner className="size-3.5" /> Checking the gcloud CLI…
            </div>
          ) : gcpEmail ? (
            <>
              {/* The sign-in, its log, then the billing account it gives access to. */}
              <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[0.75rem]">
                <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                <span className="min-w-0 truncate">
                  <span className="text-muted-foreground">Signed in as </span>
                  <span className="text-foreground">{gcpEmail}</span>
                </span>
                <button
                  type="button"
                  onClick={signIn}
                  disabled={signingIn}
                  className="ml-auto shrink-0 text-[0.6875rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                >
                  {signingIn ? "Signing in…" : "Switch account"}
                </button>
              </div>
              {signInLog && <LogConsole lines={signInLog} running={signingIn} title="Sign in" collapseOnDone />}
              {gcpBilling.length > 0 ? (
                <Field label="Billing account" hint="the labs project is billed here">
                  <Select value={v.username} onChange={(e) => set("username", e.target.value)}>
                    {!v.username && <option value="">Choose a billing account…</option>}
                    {gcpBilling.map((b) => (
                      <option key={b.id} value={b.id} disabled={!b.open}>
                        {b.name ? `${b.name} (${b.id})` : b.id}
                        {b.open ? "" : " (closed)"}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <Field label="Billing account" hint="none listed for this account; type the id">
                  <Input {...text("username")} placeholder="0X0X0X-0X0X0X-0X0X0X" />
                </Field>
              )}
              <Field label="Organization">
                <Select value={v.node ?? ""} onChange={(e) => set("node", e.target.value || null)}>
                  <option value="">No organization (personal account)</option>
                  {gcpOrgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name ? `${o.name} (${o.id})` : o.id}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-[0.75rem]">
                <span className="text-muted-foreground">Sign in with the gcloud CLI to list your billing accounts.</span>
                <Button variant="outline" size="sm" className="ml-auto" onClick={signIn} disabled={signingIn}>
                  {signingIn ? <Spinner className="size-3.5" /> : null} Sign in (gcloud)
                </Button>
              </div>
              {signInLog && <LogConsole lines={signInLog} running={signingIn} title="Sign in" collapseOnDone />}
              <Field label="Billing account" hint="or type the id">
                <Input {...text("username")} placeholder="0X0X0X-0X0X0X-0X0X0X" />
              </Field>
            </>
          )}
        </div>
      ) : v.useCliCreds ? (
        <div className="space-y-3">
          {/* The sign-in, its log, then the profile (as for GCP and Azure). */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-[0.75rem]">
            {checkingId ? (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Spinner className="size-3.5" /> Checking…
              </span>
            ) : awsIdentity ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                <span className="text-muted-foreground">Signed in as</span>
                <span className="truncate text-foreground">{awsIdentity}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">Not signed in on this profile.</span>
            )}
            <Button variant="outline" size="sm" className="ml-auto" onClick={awsSignIn} disabled={signingIn}>
              {signingIn ? <Spinner className="size-3.5" /> : null} Sign in (browser)
            </Button>
          </div>
          {signInLog && <LogConsole lines={signInLog} running={signingIn} title="Sign in" collapseOnDone />}
          {profiles.length > 0 && (
            <Field label="Profile">
              <Select value={v.awsProfile ?? ""} onChange={(e) => set("awsProfile", e.target.value || null)}>
                <option value="">default</option>
                {profiles.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Access key ID" hint="An IAM user with EC2 access">
              <Input {...text("username")} placeholder="AKIA…" />
            </Field>
            <Field label="Secret access key" hint="Stored in your OS keychain">
              <Input
                type="password"
                value={v.password ?? ""}
                onChange={(e) => set("password", e.target.value || null)}
                placeholder={editing ? "Unchanged" : ""}
                autoComplete="off"
              />
            </Field>
          </div>
          <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">
            No keys yet?{" "}
            <button
              type="button"
              onClick={() => openUrl("https://console.aws.amazon.com/iam/home#/security_credentials").catch(() => {})}
              className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
            >
              Create them in the AWS console <ExternalLink className="size-3" />
            </button>
          </p>
        </>
      )}
      <div className="mt-3">
        <Field label={azure ? "Location" : "Region"}>
          <Select value={v.host} onChange={(e) => set("host", e.target.value)}>
            {v.host &&
              !(azure ? AZURE_LOCATIONS : gcp ? GCP_REGIONS : digitalocean ? DO_REGIONS : linode ? LINODE_REGIONS : oci ? OCI_REGIONS : AWS_REGIONS).some(
                ([code]) => code === v.host,
              ) && <option value={v.host}>{v.host}</option>}
            {(azure ? AZURE_LOCATIONS : gcp ? GCP_REGIONS : digitalocean ? DO_REGIONS : linode ? LINODE_REGIONS : oci ? OCI_REGIONS : AWS_REGIONS).map(
              ([code, name]) => (
                <option key={code} value={code}>
                  {code} · {name}
                </option>
              ),
            )}
          </Select>
        </Field>
      </div>
      {error && <p className="mt-3 text-[0.75rem] text-destructive">{error}</p>}
      <Nav
        left={
          <Button variant="outline" onClick={back}>
            <ArrowLeft className="size-4" /> Back
          </Button>
        }
        right={
          <Button variant="learn" onClick={next} disabled={!connectionOk}>
            Continue
          </Button>
        }
      />
    </Step>
  );
}
