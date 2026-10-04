"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, CheckCircle2, Cloud, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LogConsole } from "@/components/ui/log-console";
import { AWS_REGIONS, AZURE_LOCATIONS } from "@/features/servers/host-setup/constants";
import { Field, Input, Nav, Select, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";

export function CredentialsStep({ s }: { s: HostSetup }) {
  const { v, error, signingIn, signInLog, editing, azure, profiles, awsIdentity, checkingId, awsSignIn, set, text, connectionOk, next, back, signIn } = s;
  return (
    <Step
      icon={Cloud}
      title={azure ? "Azure subscription" : v.useCliCreds ? "AWS CLI" : "Access keys"}
      description={
        azure
          ? "Sign in with the Azure CLI, then pick your subscription and location."
          : v.useCliCreds
            ? "Pick a profile, or sign in with the browser."
            : "An IAM user's access keys."
      }
    >
      {azure ? (
        <div className="space-y-3">
          <Field label="Subscription ID">
            <Input {...text("username")} placeholder="00000000-0000-0000-0000-000000000000" />
          </Field>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-[0.75rem]">
            <span className="text-muted-foreground">Sign in once so Terraform can use the Azure CLI.</span>
            <Button variant="outline" size="sm" className="ml-auto" onClick={signIn} disabled={signingIn}>
              {signingIn ? <Spinner className="size-3.5" /> : null} Sign in (az login)
            </Button>
          </div>
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
            {v.host && !(azure ? AZURE_LOCATIONS : AWS_REGIONS).some(([code]) => code === v.host) && <option value={v.host}>{v.host}</option>}
            {(azure ? AZURE_LOCATIONS : AWS_REGIONS).map(([code, name]) => (
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
