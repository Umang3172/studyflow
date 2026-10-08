// Plain-language data notice shown at onboarding and in Settings. Keep in sync with docs/privacy.md.
export function PrivacyNote() {
  return (
    <details className="rounded-lg border border-line bg-muted/40 p-3 text-sm">
      <summary className="cursor-pointer font-medium">What data does Studyflow keep?</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-fg">
        <li>Your chat, memories, plans and reminders, tied to an anonymous cookie in this browser. There is no account, email or student ID.</li>
        <li>
          Your messages and pasted material are sent to Cloudflare Workers AI (Llama 3.3) to write replies. Cloudflare says it does not use this content to
          train or improve models.
        </li>
        <li>Please don't paste passwords, health details, grades from other people, or anyone else's personal information.</li>
        <li>Delete everything at any time in Settings. Clearing this browser's site data also makes it unreachable.</li>
      </ul>
    </details>
  );
}
