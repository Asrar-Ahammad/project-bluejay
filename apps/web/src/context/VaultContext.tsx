import { createContext, useContext, useState } from 'react';

const VaultContext = createContext<{
  masterKey: CryptoKey | null;
  setMasterKey: (k: CryptoKey | null) => void;
}>({ masterKey: null, setMasterKey: () => {} });

export const useVault = () => useContext(VaultContext);

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const [masterKey, setMasterKey] = useState<CryptoKey | null>(null);
  return (
    <VaultContext.Provider value={{ masterKey, setMasterKey }}>
      {children}
    </VaultContext.Provider>
  );
}