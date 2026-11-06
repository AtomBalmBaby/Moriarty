import React, { useEffect, useState } from "react";

import { EVENT_NAME } from "../common/constants";

import { bridge } from "./messaging";
import { ToolInfo, ToolInventoryDialog } from "./tool-inventory-dialog";

export const ToolPicker: React.FC = () => {
  const [inventory, setInventory] = useState<ToolInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);

  useEffect(() => {
    const fetchInventory = async () => {
      try {
        const data = await bridge.request(EVENT_NAME.twinnyToolInventory);
        setInventory(data ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    fetchInventory();
  }, []);

  const handleConfirm = (selected: ToolInfo[]) => {
    console.log("Selected tools", selected);
  };

  return (
    <div>
      <button onClick={() => setShowDialog(true)}>Configure Tools</button>
{error && <div style={{color: "red", marginTop: "8px"}}>{error}</div>}
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