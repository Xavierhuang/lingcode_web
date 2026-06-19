import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-8">
      <div className="max-w-md w-full space-y-6 text-center">
        <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-primary text-primary-foreground">
          <Sparkles className="h-6 w-6" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Welcome to your app</h1>
        <p className="text-muted-foreground">
          A real Vite + React + TypeScript + Tailwind + shadcn project. Edit{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-sm">src/App.tsx</code> and the preview hot-reloads.
        </p>
        <div className="flex gap-2 justify-center">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
        </div>
      </div>
    </div>
  );
}
