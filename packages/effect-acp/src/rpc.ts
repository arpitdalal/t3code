import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { AGENT_METHODS, CLIENT_METHODS } from "./_generated/meta.gen.ts";

// ndJsonRpc maps standard JSON-RPC `error` objects to Exit Die(defect=error).
// Default Schema.Defect() treats `{message}` as a JSON Error and rebuilds
// `new Error(message)`, dropping `code`/`data`. Prefer the protocol shape first.
export const AcpDefect = Schema.Union([AcpSchema.Error, Schema.Defect()]);

const withAcpErrors = <O extends { readonly payload: unknown; readonly success: unknown }>(
  options: O,
) => ({
  ...options,
  error: AcpSchema.Error,
  defect: AcpDefect,
});

const InitializeRpc = Rpc.make(
  AGENT_METHODS.initialize,
  withAcpErrors({
    payload: AcpSchema.InitializeRequest,
    success: AcpSchema.InitializeResponse,
  }),
);

const AuthenticateRpc = Rpc.make(
  AGENT_METHODS.authenticate,
  withAcpErrors({
    payload: AcpSchema.AuthenticateRequest,
    success: AcpSchema.AuthenticateResponse,
  }),
);

const LogoutRpc = Rpc.make(
  AGENT_METHODS.logout,
  withAcpErrors({
    payload: AcpSchema.LogoutRequest,
    success: AcpSchema.LogoutResponse,
  }),
);

const NewSessionRpc = Rpc.make(
  AGENT_METHODS.session_new,
  withAcpErrors({
    payload: AcpSchema.NewSessionRequest,
    success: AcpSchema.NewSessionResponse,
  }),
);

const LoadSessionRpc = Rpc.make(
  AGENT_METHODS.session_load,
  withAcpErrors({
    payload: AcpSchema.LoadSessionRequest,
    success: AcpSchema.LoadSessionResponse,
  }),
);

const ListSessionsRpc = Rpc.make(
  AGENT_METHODS.session_list,
  withAcpErrors({
    payload: AcpSchema.ListSessionsRequest,
    success: AcpSchema.ListSessionsResponse,
  }),
);

const ForkSessionRpc = Rpc.make(
  AGENT_METHODS.session_fork,
  withAcpErrors({
    payload: AcpSchema.ForkSessionRequest,
    success: AcpSchema.ForkSessionResponse,
  }),
);

const ResumeSessionRpc = Rpc.make(
  AGENT_METHODS.session_resume,
  withAcpErrors({
    payload: AcpSchema.ResumeSessionRequest,
    success: AcpSchema.ResumeSessionResponse,
  }),
);

const CloseSessionRpc = Rpc.make(
  AGENT_METHODS.session_close,
  withAcpErrors({
    payload: AcpSchema.CloseSessionRequest,
    success: AcpSchema.CloseSessionResponse,
  }),
);

const PromptRpc = Rpc.make(
  AGENT_METHODS.session_prompt,
  withAcpErrors({
    payload: AcpSchema.PromptRequest,
    success: AcpSchema.PromptResponse,
  }),
);

const SetSessionModelRpc = Rpc.make(
  AGENT_METHODS.session_set_model,
  withAcpErrors({
    payload: AcpSchema.SetSessionModelRequest,
    success: AcpSchema.SetSessionModelResponse,
  }),
);

const SetSessionConfigOptionRpc = Rpc.make(
  AGENT_METHODS.session_set_config_option,
  withAcpErrors({
    payload: AcpSchema.SetSessionConfigOptionRequest,
    success: AcpSchema.SetSessionConfigOptionResponse,
  }),
);

const ReadTextFileRpc = Rpc.make(
  CLIENT_METHODS.fs_read_text_file,
  withAcpErrors({
    payload: AcpSchema.ReadTextFileRequest,
    success: AcpSchema.ReadTextFileResponse,
  }),
);

const WriteTextFileRpc = Rpc.make(
  CLIENT_METHODS.fs_write_text_file,
  withAcpErrors({
    payload: AcpSchema.WriteTextFileRequest,
    success: AcpSchema.WriteTextFileResponse,
  }),
);

const RequestPermissionRpc = Rpc.make(
  CLIENT_METHODS.session_request_permission,
  withAcpErrors({
    payload: AcpSchema.RequestPermissionRequest,
    success: AcpSchema.RequestPermissionResponse,
  }),
);

const ElicitationRpc = Rpc.make(
  CLIENT_METHODS.session_elicitation,
  withAcpErrors({
    payload: AcpSchema.ElicitationRequest,
    success: AcpSchema.ElicitationResponse,
  }),
);

// The pinned v0.11.3 schema predates the SDK's method name and flat response.
// Keep its RPC for existing peers and translate the SDK alias at the boundary.
const CreateElicitationRpc = Rpc.make(
  "elicitation/create",
  withAcpErrors({
    payload: Schema.Unknown,
    success: Schema.Struct({
      action: Schema.Literals(["accept", "decline", "cancel"]),
      content: Schema.optionalKey(
        Schema.NullOr(Schema.Record(Schema.String, AcpSchema.ElicitationContentValue)),
      ),
      _meta: AcpSchema.ElicitationResponse.fields._meta,
    }),
  }),
);

const CreateTerminalRpc = Rpc.make(
  CLIENT_METHODS.terminal_create,
  withAcpErrors({
    payload: AcpSchema.CreateTerminalRequest,
    success: AcpSchema.CreateTerminalResponse,
  }),
);

const TerminalOutputRpc = Rpc.make(
  CLIENT_METHODS.terminal_output,
  withAcpErrors({
    payload: AcpSchema.TerminalOutputRequest,
    success: AcpSchema.TerminalOutputResponse,
  }),
);

const ReleaseTerminalRpc = Rpc.make(
  CLIENT_METHODS.terminal_release,
  withAcpErrors({
    payload: AcpSchema.ReleaseTerminalRequest,
    success: AcpSchema.ReleaseTerminalResponse,
  }),
);

const WaitForTerminalExitRpc = Rpc.make(
  CLIENT_METHODS.terminal_wait_for_exit,
  withAcpErrors({
    payload: AcpSchema.WaitForTerminalExitRequest,
    success: AcpSchema.WaitForTerminalExitResponse,
  }),
);

const KillTerminalRpc = Rpc.make(
  CLIENT_METHODS.terminal_kill,
  withAcpErrors({
    payload: AcpSchema.KillTerminalRequest,
    success: AcpSchema.KillTerminalResponse,
  }),
);

export const AgentRpcs = RpcGroup.make(
  InitializeRpc,
  AuthenticateRpc,
  LogoutRpc,
  NewSessionRpc,
  LoadSessionRpc,
  ListSessionsRpc,
  ForkSessionRpc,
  ResumeSessionRpc,
  CloseSessionRpc,
  PromptRpc,
  SetSessionModelRpc,
  SetSessionConfigOptionRpc,
);

export const ClientRpcs = RpcGroup.make(
  ReadTextFileRpc,
  WriteTextFileRpc,
  RequestPermissionRpc,
  ElicitationRpc,
  CreateElicitationRpc,
  CreateTerminalRpc,
  TerminalOutputRpc,
  ReleaseTerminalRpc,
  WaitForTerminalExitRpc,
  KillTerminalRpc,
);
