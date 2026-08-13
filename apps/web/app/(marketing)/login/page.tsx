import { LoginForm } from '../../../components/login-form';
import { BrandLockup } from '../../../components/brand';

export const metadata = { title: 'Sign in · OutreachGraph' };

export default function LoginPage() {
  return (
    <div className="flex min-h-[80dvh] flex-col justify-center">
      <header className="mb-6">
        {/* The lockup is the heading here, so it carries the h1 rather than sitting above one. */}
        <h1>
          <BrandLockup size="lg" />
        </h1>
        <p className="text-ink-muted mt-1 text-sm">
          Turn public intent signals into warm conversations.
        </p>
      </header>

      <LoginForm />
    </div>
  );
}
