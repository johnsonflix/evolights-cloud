'use client';

/**
 * Tiny client component that intercepts the form submit and pops a native
 * confirm dialog. Returns false from onClick if the user cancels — the
 * outer <form action={softDelete}> won't fire. Native confirm is fine for
 * an admin tool; nicer modal libraries are not worth the bundle.
 */

import { useFormStatus } from 'react-dom';

export default function ConfirmDeleteButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn-danger"
      disabled={pending}
      onClick={(e) => {
        if (!confirm('Soft-delete this account? The user will be logged out everywhere and cannot log in again.')) {
          e.preventDefault();
        }
      }}
    >
      {pending ? 'Deleting…' : 'Delete account'}
    </button>
  );
}
