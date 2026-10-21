import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '../ui/Button';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/** Last line of defence: shows a recovery screen instead of a blank page if rendering crashes. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error:', error, info.componentStack);
  }

  override render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div role="alert" className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col justify-center px-4">
        <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-2 text-ink-muted">Linka hit an unexpected error. Reloading the page usually fixes it.</p>
        <div className="mt-6">
          <Button onClick={() => window.location.reload()}>Reload page</Button>
        </div>
      </div>
    );
  }
}
