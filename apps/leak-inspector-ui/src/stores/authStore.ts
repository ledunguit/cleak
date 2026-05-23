import { create } from 'zustand';

interface AuthUser {
  userId: string;
  githubUserId: number;
  login: string;
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  initialized: boolean;
  initialize: () => Promise<void>;
  setAuth: (user: AuthUser, token: string) => void;
  logout: () => Promise<void>;
  getAuthHeaders: () => Record<string, string>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: localStorage.getItem('auth_token'),
  initialized: false,

  initialize: async () => {
    const token = localStorage.getItem('auth_token');
    if (!token) {
      set({ initialized: true, token: null, user: null });
      return;
    }
    try {
      const response = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        localStorage.removeItem('auth_token');
        set({ initialized: true, token: null, user: null });
        return;
      }
      const user = await response.json();
      set({ user, token, initialized: true });
    } catch {
      localStorage.removeItem('auth_token');
      set({ initialized: true, token: null, user: null });
    }
  },

  setAuth: (user, token) => {
    localStorage.setItem('auth_token', token);
    set({ user, token });
  },

  logout: async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch { /* non-critical */ }
    localStorage.removeItem('auth_token');
    set({ user: null, token: null });
  },

  getAuthHeaders: (): Record<string, string> => {
    const token = get().token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  },
}));
