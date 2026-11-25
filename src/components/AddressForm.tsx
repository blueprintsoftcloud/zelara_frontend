import React from "react";
import toast from "react-hot-toast";
import { fetchPincodeDetails } from "../utils/pincodeLookup";

interface Address {
  name: string;
  phone: string;
  house: string;
  street: string;
  city: string;
  state: string;
  pincode: string;
  locality?: string;
  lat?: number;
  lng?: number;
  shippingCharge?: number;
}

interface AddressFormProps {
  address: Address;
  setAddress: React.Dispatch<React.SetStateAction<Address>>;
}

const AddressForm = ({ address, setAddress }: AddressFormProps) => {
  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    if (name === "phone") {
      const digits = value.replace(/\D/g, "").slice(0, 10);
      setAddress({ ...address, phone: digits });
    } else if (name === "pincode") {
      const cleanPincode = value.replace(/\D/g, "").slice(0, 6);
      setAddress((prev) => ({ ...prev, pincode: cleanPincode }));

      if (cleanPincode.length === 6) {
        try {
          const result = await fetchPincodeDetails(cleanPincode);
          if (result.success) {
            const autoLocality = result.localities.length === 1 ? result.localities[0] : "";
            setAddress((prev) => ({
              ...prev,
              state: result.state || prev.state,
              city: result.city || prev.city,
              locality: autoLocality || prev.locality,
            }));
            toast.success(`Resolved to ${result.city}, ${result.state}`);
          } else {
            toast.error(result.error || "Pincode not found");
          }
        } catch (err) {
          console.error("Failed to fetch state/city from pincode", err);
        }
      }
    } else {
      setAddress({ ...address, [name]: value });
    }
  };

  return (
    <div className="bg-white border rounded-lg p-6">
      <h2 className="text-xl font-semibold mb-4">Delivery Address</h2>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-bold uppercase text-gray-500 mb-1">
            Please enter pincode to check delivery address
          </label>
          <input
            name="pincode"
            placeholder="Pincode"
            value={address.pincode}
            onChange={handleChange}
            className="input"
          />
        </div>
        <input
          name="name"
          placeholder="Full Name"
          value={address.name}
          onChange={handleChange}
          className="input"
        />
        <input
          name="phone"
          type="tel"
          inputMode="numeric"
          maxLength={10}
          placeholder="Phone Number (10 digits)"
          value={address.phone}
          onChange={handleChange}
          className="input"
        />
        <input
          name="house"
          placeholder="House / Flat"
          value={address.house}
          onChange={handleChange}
          className="input"
        />
        <input
          name="street"
          placeholder="Street / Area"
          value={address.street}
          onChange={handleChange}
          className="input"
        />
        <div className="grid grid-cols-2 gap-4">
          <input
            name="city"
            placeholder="City (Auto-filled)"
            value={address.city}
            readOnly={true}
            className="input bg-slate-100/80 text-slate-500 cursor-not-allowed select-none"
          />
          <input
            name="state"
            placeholder="State (Auto-filled)"
            value={address.state}
            readOnly={true}
            className="input bg-slate-100/80 text-slate-500 cursor-not-allowed select-none"
          />
        </div>
      </div>
    </div>
  );
};

export default AddressForm;
