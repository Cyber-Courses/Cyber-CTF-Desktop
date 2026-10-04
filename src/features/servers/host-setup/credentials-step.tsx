"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, CheckCircle2, Cloud, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/ui/log-console";
import { AWS_REGIONS, AZURE_LOCATIONS, GCP_REGIONS } from "@/features/servers/host-setup/constants";
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
    profiles,
    awsIdentity,
    checkingId,
    azureSubs,
    azureChecking,
    gcpProjs,
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
      title={azure ? "Azure subscription" : gcp ? "Google Cloud project" : v.useCliCreds ? "AWS CLI" : "Access keys"}
      description={
        azure
          ? "Sign in with the Azure CLI, then pick your subscription and location."
          : gcp
            ? "Sign in with the gcloud CLI, then pick your project and region."
            : v.useCliCreds
              ? "Pick a profile, or sign in with the browser."
              : "An IAM user's access keys."
      }
    >
      {azure ? (
        <div className="space-y-3">
          {azureChecking ? (
            <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-[0.75rem] text-muted-foreground">
              <Spinner className="size-3.5" /> Checking the Azure CLI…
            </div>
          ) : azureSubs.length > 0 ? (
            <>
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
              <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-500" />
                <span className="text-emerald-500">Signed in to the Azure CLI.</span>
                <button type="button" onClick={signIn} disabled={signingIn} className="ml-auto underline-offset-2 hover:underline disabled:opacity-50">
                  {signingIn ? "Signing in…" : "Switch account"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-[0.75rem]">
                <span className="text-muted-foreground">Sign in with the Azure CLI to list your subscriptions.</span>
                <Button variant="outline" size="sm" className="ml-auto" onClick={signIn} disabled={signingIn}>
                  {signingIn ? <Spinner className="size-3.5" /> : null} Sign in (az login)
                </Button>
              </div>
              <Field label="Subscription ID" hint="or paste it">
                <Input {...text("username")} placeholder="00000000-0000-0000-0000-000000000000" />
              </Field>
            </>
          )}
          {signInLog && <LogConsole lines={signInLog} running={signingIn} title="Sign in" />}
        </div>
      ) : gcp ? (
        <div className="space-y-3">
          {gcpChecking ? (
            <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-[0.75rem] text-muted-foreground">
              <Spinner className="size-3.5" /> Checking the gcloud CLI…
            </div>
          ) : gcpEmail ? (
            <>
              {gcpProjs.length > 0 ? (
                <Field label="Project">
                  <Select value={v.username} onChange={(e) => set("username", e.target.value)}>
                    {!v.username && <option value="">Choose a project…</option>}
                    {gcpProjs.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name ? `${p.name} (${p.id})` : p.id}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <Field label="Project ID" hint="no projects listed; type one">
                  <Input {...text("username")} placeholder="my-lab-project" />
                </Field>
              )}
              <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                <span className="truncate text-emerald-500">Signed in as {gcpEmail}.</span>
                <button type="button" onClick={signIn} disabled={signingIn} className="ml-auto shrink-0 underline-offset-2 hover:underline disabled:opacity-50">
                  {signingIn ? "Signing in…" : "Switch account"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-[0.75rem]">
                <span className="text-muted-foreground">Sign in with the gcloud CLI to list your projects.</span>
                <Button variant="outline" size="sm" className="ml-auto" onClick={signIn} disabled={signingIn}>
                  {signingIn ? <Spinner className="size-3.5" /> : null} Sign in (gcloud)
                </Button>
              </div>
              <Field label="Project ID" hint="or type it">
                <Input {...text("username")} placeholder="my-lab-project" />
              </Field>
            </>
          )}
          {signInLog && <LogConsole lines={signInLog} running={signingIn} title="Sign in" />}
        </div>
      ) : v.useCliCreds ? (
        <div className="space-y-3">
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
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-[0.75rem]">
            {checkingId ? (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Spinner className="size-3.5" /> Checking…
              </span>
            ) : awsIdentity ? (
              <span className="flex items-center gap-1.5 text-emerald-500">
                <CheckCircle2 className="size-3.5" /> Signed in as {awsIdentity}
              </span>
            ) : (
              <span className="text-muted-foreground">Not signed in on this profile.</span>
            )}
            <Button variant="outline" size="sm" className="ml-auto" onClick={awsSignIn} disabled={signingIn}>
              {signingIn ? <Spinner className="size-3.5" /> : null} Sign in (browser)
            </Button>
          </div>
          {signInLog && <LogConsole lines={signInLog} running={signingIn} title="Sign in" />}
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
            {v.host && !(azure ? AZURE_LOCATIONS : gcp ? GCP_REGIONS : AWS_REGIONS).some(([code]) => code === v.host) && (
              <option value={v.host}>{v.host}</option>
            )}
            {(azure ? AZURE_LOCATIONS : gcp ? GCP_REGIONS : AWS_REGIONS).map(([code, name]) => (
              <option key={code} value={code}>
                {code} — {name}
              </option>
            ))}
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
