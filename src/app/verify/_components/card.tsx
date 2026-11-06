/** The centred card the verify/sign-in pages share (light theme tokens from globals.css). */
export function VerifyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-surface px-4 py-16">
      <main className="w-full max-w-md rounded-2xl border border-ink/10 bg-background p-8 text-center shadow-sm">
        <p className="text-sm font-semibold tracking-tight text-ink/60">Mandate</p>
        {children}
        <p className="mt-8 text-xs text-ink/40">PayPal sandbox · no real money moves</p>
      </main>
    </div>
  );
}
