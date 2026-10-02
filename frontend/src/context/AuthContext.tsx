import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi, setUnauthorizedHandler, type SessionIdentity } from '../lib/api';

export type UserSession = SessionIdentity;

interface AuthContextType {
  user: UserSession | null;
  isLoading: boolean;
  /** Restaurant currently being operated on. Always the admin's own restaurant for tenant admins. */
  activeRestaurantId: string | null;
  setActiveRestaurantId: (id: string | null) => void;
  login: (email: string, password?: string) => Promise<UserSession>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const STORAGE_KEY = 'workforce_active_restaurant';

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(id: string | null): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [storedRestaurantId, setStoredRestaurantId] = useState<string | null>(readStored);

  const setActiveRestaurantId = useCallback((id: string | null) => {
    setStoredRestaurantId(id);
    writeStored(id);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      setUser(await authApi.me());
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  // Session expiry anywhere in the app returns the user to sign-in.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(
    async (email: string, password?: string) => {
      const res = await authApi.login({ email, password });
      const identity: UserSession = {
        adminAccountId: res.adminAccountId,
        accountKind: res.accountKind,
        restaurantId: res.restaurantId,
        fullName: res.fullName,
        email: res.email,
      };
      setUser(identity);
      if (identity.accountKind === 'RESTAURANT_ADMIN') setActiveRestaurantId(identity.restaurantId);
      return identity;
    },
    [setActiveRestaurantId]
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* session may already be gone */
    } finally {
      setUser(null);
      setActiveRestaurantId(null);
    }
  }, [setActiveRestaurantId]);

  const activeRestaurantId =
    user?.accountKind === 'RESTAURANT_ADMIN' ? user.restaurantId : storedRestaurantId;

  return (
    <AuthContext.Provider
      value={{ user, isLoading, activeRestaurantId, setActiveRestaurantId, login, logout, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
