import { ForgotPasswordForm } from '../../../components/forgot-password-form';
import { BrandLockup } from '../../../components/brand';

export const metadata = { title: 'Reset your password · OutreachGraph' };

/**
 * Asks which address to mail a reset link to.
 *
 * Laid out like /login rather than /verify, because it is the same job from
 * the visitor's side — the screen you land on when you cannot get in — and it
 * is reached from a link on the sign-in card.
 */
export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-[80dvh] items-center justify-center px-5 py-12">
      <div className="border-border w-full max-w-sm sm:rounded-2xl sm:border sm:p-8">
        <header className="mb-6">
          <BrandLockup size="lg" />
          <h1 className="mt-4 text-xl font-semibold">Reset your password</h1>
          <p className="text-ink-muted mt-2 text-sm">
            Enter the address you signed up with and we will email you a link.
          </p>
        </header>

        <ForgotPasswordForm />
      </div>
    </div>
  );
}
