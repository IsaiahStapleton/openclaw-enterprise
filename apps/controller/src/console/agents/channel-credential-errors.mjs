import { element } from "../dom.mjs";

const messages = {
  CHANNEL_CREDENTIAL_ROLE_MISMATCH:
    "This Secret has the wrong token role. Select an app token (xapp) for the app field and a bot token (xoxb) for the bot field.",
  CHANNEL_CREDENTIAL_CREDENTIALS_REJECTED:
    "Slack rejected this bot credential. Check the selected Secret and retry.",
  CHANNEL_CREDENTIAL_UNAVAILABLE:
    "Slack credential validation is temporarily unavailable. Retry before deploying.",
  CHANNEL_CREDENTIAL_CHANGED:
    "This Secret changed during validation. Retry to check its current value.",
  CHANNEL_CREDENTIAL_BINDING_REQUIRED:
    "Select an environment-backed Secret for this channel credential.",
};

export function channelCredentialMessage(error) {
  return messages[error?.code] ?? null;
}

export function channelCredentialFieldMessage(error, binding) {
  const field = binding.key === "SLACK_APP_TOKEN" ? "appToken" : "botToken";
  return error?.details?.some((detail) => detail.path === `/channels/slack/${field}`)
    ? channelCredentialMessage(error)
    : null;
}

export function clearChannelCredentialError(field) {
  const error = field.querySelector("[data-channel-credential-error]");
  if (!error) {
    return;
  }
  const input = field.querySelector('input[role="combobox"]');
  input?.removeAttribute("aria-invalid");
  const description = input
    ?.getAttribute("aria-describedby")
    ?.split(" ")
    .filter((id) => id !== error.id)
    .join(" ");
  if (description) {
    input.setAttribute("aria-describedby", description);
  } else {
    input?.removeAttribute("aria-describedby");
  }
  error.remove();
}

export function showChannelCredentialError(field, binding, error) {
  clearChannelCredentialError(field);
  const message = channelCredentialFieldMessage(error, binding);
  const input = field.querySelector('input[role="combobox"]');
  if (!message || !input) {
    return;
  }
  const id = `${input.id}-credential-error`;
  field.append(
    element(
      "p",
      { id, className: "error", role: "alert", "data-channel-credential-error": "" },
      message,
    ),
  );
  input.setAttribute("aria-invalid", "true");
  input.setAttribute(
    "aria-describedby",
    [input.getAttribute("aria-describedby"), id].filter(Boolean).join(" "),
  );
}
