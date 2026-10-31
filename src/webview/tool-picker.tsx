import React, { useEffect, useState } from "react";
import { bridge } from "./messaging";
import { ToolInventoryDialog } from "./tool-inventory-dialog";
import { EVENT_NAME } from "../common/constants";

export const ToolPicker: React.FC = () => {
  const [inventory, setInventory] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);

  useEffect(() => {
    const fetchInventory = async () => {
      try {
        const data = await bridge.request(EVENT_NAME.twinnyToolInventory as any);
        setInventory((data ?? []) as any[]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    fetchInventory();
  }, []);

  const handleConfirm = (selected: any[]) => {
    console.log("Selected tools", selected);
  };

  return (
    <div>
      <button onClick={() => setShowDialog(true)}>Configure Tools</button>
{error && <div style={{color: 'red', marginTop: '8px'}}>{error}</div>}
      {showDialog && (
        <ToolInventoryDialog
          inventory={inventory}
          onClose={() => setShowDialog(false)}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
};