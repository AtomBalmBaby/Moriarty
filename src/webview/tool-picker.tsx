import React, { useEffect, useState } from "react";
import { bridge } from "./messaging";
import { ToolInventoryDialog } from "./tool-inventory-dialog";
import { EVENT_NAME } from "../common/constants";

export const ToolPicker: React.FC = () => {
  const [inventory, setInventory] = useState<any[]>([]);
  const [showDialog, setShowDialog] = useState(false);

  useEffect(() => {
    const fetchInventory = async () => {
      try {
        const data = await bridge.request(EVENT_NAME.twinnyToolInventory as any);
        setInventory((data ?? []) as any[]);
      } catch (e) {
        console.error("Failed to fetch tool inventory", e);
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