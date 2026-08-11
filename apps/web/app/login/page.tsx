import { LoginForm } from '../../components/login-form';

export const metadata = { title: 'Sign in · OutreachGraph' };

export default function LoginPage() {
  return (
    <div className="flex min-h-[80dvh] flex-col justify-center">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">OutreachGraph</h1>
        <p className="text-ink-muted mt-1 text-sm">
          Turn public intent signals into warm conversations.
        </p>
      </header>

      <LoginForm />
    </div>
  );
}
