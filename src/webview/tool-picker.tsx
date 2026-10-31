
import React, { useEffect, useState } from "react";
import { bridge } from "./messaging";
import { EVENT_NAME } from "../common/constants";

export const ToolPicker: React.FC = () => {
  const [inventory, setInventory] = useState<any[]>([]);

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

  return (
    <div>
      <h3>Tool Inventory</h3>
      <ul>
        {inventory.map((tool, idx) => (
          <li key={idx}>
            {tool.server}/{tool.tool} - {tool.description}
          </li>
        ))}
      </ul>
    </div>
  );
};

