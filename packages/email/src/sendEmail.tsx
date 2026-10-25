import { render } from "@react-email/render";
import nodemailer from "nodemailer";
import { createElement } from "react";

import { createLogger } from "@kan/logger";

import JoinWorkspaceTemplate from "./templates/join-workspace";
import MagicLinkTemplate from "./templates/magic-link";
import MentionTemplate from "./templates/mention";
import ResetPasswordTemplate from "./templates/reset-password";

const log = createLogger("email");

interface TemplateProps {
  MAGIC_LINK: React.ComponentProps<typeof MagicLinkTemplate>;
  JOIN_WORKSPACE: React.ComponentProps<typeof JoinWorkspaceTemplate>;
  RESET_PASSWORD: React.ComponentProps<typeof ResetPasswordTemplate>;
  MENTION: React.ComponentProps<typeof MentionTemplate>;
}

const emailTemplates: {
  [Template in keyof TemplateProps]: React.ComponentType<
    TemplateProps[Template]
  >;
} = {
  MAGIC_LINK: MagicLinkTemplate,
  JOIN_WORKSPACE: JoinWorkspaceTemplate,
  RESET_PASSWORD: ResetPasswordTemplate,
  MENTION: MentionTemplate,
};

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure:
    process.env.SMTP_SECURE === undefined
      ? true
      : process.env.SMTP_SECURE.toLowerCase() === "true",
  tls: {
    // do not fail on invalid certs
    rejectUnauthorized:
      process.env.SMTP_REJECT_UNAUTHORIZED === undefined
        ? true
        : process.env.SMTP_REJECT_UNAUTHORIZED.toLowerCase() === "true",
  },
  ...(process.env.SMTP_USER &&
    process.env.SMTP_PASSWORD && {
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    }),
});

export const sendEmail = async <Template extends keyof TemplateProps>(
  to: string,
  subject: string,
  template: Template,
  data: TemplateProps[Template],
) => {
  log.info({ to, subject, template }, "Sending email");
  try {
    const EmailTemplate = emailTemplates[template];

    const html = await render(
      createElement<TemplateProps[Template]>(EmailTemplate, data),
      { pretty: true },
    );

    const options = {
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html,
    };

    const response = await transporter.sendMail(options);

    if (!response.accepted.length) {
      throw new Error(`Failed to send email: ${response.response}`);
    }

    log.info(
      { to, subject, template, messageId: response.messageId },
      "Email sent",
    );
    return response;
  } catch (error) {
    log.error(
      { err: error, to, from: process.env.EMAIL_FROM, subject, template },
      "Email sending failed",
    );
    throw error;
  }
};
